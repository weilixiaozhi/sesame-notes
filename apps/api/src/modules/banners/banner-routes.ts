import { readFile } from 'node:fs/promises';
import type { AppBanner, Prisma, PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { ApiConfig } from '../../shared/api-config.js';
import { ApiError } from '../../shared/errors.js';
import { execute } from '../../shared/execute.js';
import { authenticateAdmin, verifyAdminWriteRequest, withAdminMutation, writeAuditLog } from '../admin/index.js';
import { bannerMediaFile, MAX_BANNER_BYTES, publishBannerMedia, validateBannerImage } from './banner-media.js';
import {
  BANNER_SLOTS,
  BannerEntrySchema,
  BannerListSchema,
  BannerMediaIdSchema,
  BannerSlotSchema,
  BannerUpdateSchema,
  BannerUploadResponseSchema,
  type BannerSlot,
  type BannerUpdate,
} from './banner-schemas.js';

const slotNames: Record<BannerSlot, string> = {
  'fitness-plan-library': '计划库入口',
  'fitness-template-library': '模板库入口',
};

/** 明确返回客户端需要的字段，默认版本零表示此位置尚未保存服务器覆盖。 */
export function bannerResponse(slot: BannerSlot, row?: AppBanner | null) {
  return {
    slot,
    image_path: row?.imageId ? `/api/v1/banners/media/${row.imageId}` : null,
    target: row?.target ?? slot,
    is_enabled: row?.isEnabled ?? false,
    version: row?.version ?? 0,
    updated_at: row?.updatedAt.toISOString() ?? null,
  };
}

/** 安全事务已串行化管理写入；版本零只允许首次创建，后续修改必须匹配当前版本。 */
export async function saveBanner(tx: Prisma.TransactionClient, slot: BannerSlot, body: BannerUpdate, username: string) {
  try {
    const current = await tx.appBanner.findUnique({ where: { slot } });
    if ((current?.version ?? 0) !== body.version)
      throw new ApiError(409, 'BANNER_VERSION_CONFLICT', 'Banner 已被其他管理员修改，请刷新后重试');
    if (body.is_enabled && !body.image_id) throw new ApiError(400, 'BANNER_IMAGE_REQUIRED', '启用 Banner 前请选择图片');
    if (body.image_id && !(await tx.appBannerMedia.findUnique({ where: { id: body.image_id } })))
      throw new ApiError(400, 'BANNER_MEDIA_NOT_FOUND', '所选图片不存在，请重新上传');
    const data = {
      imageId: body.image_id,
      target: body.target,
      isEnabled: body.is_enabled,
      updatedBy: username,
      version: body.version + 1,
    };
    return current
      ? await tx.appBanner.update({ where: { slot, version: body.version }, data })
      : await tx.appBanner.create({ data: { slot, ...data } });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // 同一位置的首次并发创建和乐观锁失败均返回可重试的业务冲突，不泄露数据库异常。
    if (error && typeof error === 'object' && 'code' in error && ['P2002', 'P2025'].includes(String(error.code)))
      throw new ApiError(409, 'BANNER_VERSION_CONFLICT', 'Banner 已被其他管理员修改，请刷新后重试');
    throw error;
  }
}

/** 公开读取仅发布启用覆盖，后台读取始终包含固定的两个可配置位置。 */
export function registerBannerRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  app.get(
    '/api/v1/banners',
    { schema: { tags: ['banners'], operationId: 'getAppBanners', response: { 200: BannerListSchema } } },
    async (request, reply) =>
      execute(request, '读取应用 Banner', async () => {
        const rows = await prisma.appBanner.findMany({ where: { isEnabled: true }, orderBy: { slot: 'asc' } });
        // 配置不能被代理长期缓存，停用或替换后客户端下一次读取立即拿到新内容。
        reply.header('cache-control', 'no-store');
        return { items: rows.map((row) => bannerResponse(row.slot as BannerSlot, row)) };
      }),
  );
  app.get(
    '/api/v1/admin/banners',
    {
      preHandler: authenticateAdmin(config, prisma, 'banners:read'),
      schema: { tags: ['admin-banners'], operationId: 'listAdminBanners', response: { 200: BannerListSchema } },
    },
    async (request) =>
      execute(request, '查询 Banner 配置', async () => {
        const rows = await prisma.appBanner.findMany();
        return {
          items: BANNER_SLOTS.map((slot) =>
            bannerResponse(
              slot,
              rows.find((row) => row.slot === slot),
            ),
          ),
        };
      }),
  );
  app.put(
    '/api/v1/admin/banners/:slot',
    {
      onRequest: verifyAdminWriteRequest(config),
      preHandler: authenticateAdmin(config, prisma, 'banners:write'),
      schema: {
        tags: ['admin-banners'],
        operationId: 'updateAdminBanner',
        params: Type.Object({ slot: BannerSlotSchema }),
        body: BannerUpdateSchema,
        response: { 200: BannerEntrySchema },
      },
    },
    async (request) =>
      execute(request, '保存 Banner 配置', async () => {
        const { slot } = request.params as { slot: BannerSlot };
        const body = request.body as BannerUpdate;
        return withAdminMutation(prisma, request, 'banners:write', async (tx, auth) => {
          const row = await saveBanner(tx, slot, body, auth.username);
          await writeAuditLog(tx, {
            actor: `admin:${auth.adminId}`,
            action: 'banner.update',
            target: { type: 'app_banner', id: slot },
            requestId: request.id,
            ip: request.ip,
            metadata: { target_display: slotNames[slot], is_enabled: row.isEnabled, version: row.version },
          });
          return bannerResponse(slot, row);
        });
      }),
  );
  registerBannerMediaRoutes(app, prisma, config);
}

/** 图片上传受独立权限保护，公开媒体地址只读取当前启用 Banner 的引用。 */
function registerBannerMediaRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  app.post(
    '/api/v1/admin/banners/media',
    {
      onRequest: verifyAdminWriteRequest(config),
      preHandler: authenticateAdmin(config, prisma, 'banners:write'),
      bodyLimit: Math.ceil((MAX_BANNER_BYTES * 4) / 3) + 4096,
      schema: {
        tags: ['admin-banners'],
        operationId: 'uploadAdminBannerImage',
        body: Type.Object(
          {
            filename: Type.String({ minLength: 1, maxLength: 200 }),
            data_base64: Type.String({ minLength: 1, maxLength: Math.ceil((MAX_BANNER_BYTES * 4) / 3) }),
          },
          { additionalProperties: false },
        ),
        response: { 201: BannerUploadResponseSchema },
      },
    },
    async (request, reply) =>
      execute(request, '上传 Banner 图片', async () => {
        const body = request.body as { filename: string; data_base64: string };
        const media = await validateBannerImage(body.filename, body.data_base64);
        await publishBannerMedia(prisma, config.storagePath, media, request.log, (publish) =>
          withAdminMutation(prisma, request, 'banners:write', async (tx, auth) => {
            await publish(tx);
            await tx.appBannerMedia.upsert({
              where: { id: media.id },
              create: {
                id: media.id,
                fileName: body.filename,
                byteSize: media.bytes.length,
                width: media.width,
                height: media.height,
                createdBy: auth.username,
              },
              update: {},
            });
            await writeAuditLog(tx, {
              actor: `admin:${auth.adminId}`,
              action: 'banner.media.upload',
              target: { type: 'banner_media', id: media.id },
              requestId: request.id,
              ip: request.ip,
              metadata: { target_display: 'Banner 图片', byte_size: media.bytes.length },
            });
          }),
        );
        return reply.code(201).send({
          id: media.id,
          image_path: `/api/v1/banners/media/${media.id}`,
          width: media.width,
          height: media.height,
        });
      }),
  );
  for (const admin of [false, true]) {
    app.get(
      `/api/v1/${admin ? 'admin/' : ''}banners/media/:media_id`,
      {
        ...(admin ? { preHandler: authenticateAdmin(config, prisma, 'banners:read') } : {}),
        schema: {
          tags: [admin ? 'admin-banners' : 'banners'],
          operationId: admin ? 'getAdminBannerImage' : 'getAppBannerImage',
          params: Type.Object({ media_id: BannerMediaIdSchema }),
          response: { 200: Type.String({ format: 'binary' }) },
        },
      },
      async (request, reply) =>
        execute(request, '读取 Banner 图片', async () => {
          const { media_id: id } = request.params as { media_id: string };
          const media = await prisma.appBannerMedia.findUnique({ where: { id } });
          const referenced =
            admin ||
            (await prisma.appBanner.findFirst({ where: { imageId: id, isEnabled: true }, select: { slot: true } }));
          if (!media || !referenced) throw new ApiError(404, 'BANNER_MEDIA_NOT_FOUND', 'Banner 图片不存在');
          let bytes: Buffer;
          try {
            bytes = await readFile(bannerMediaFile(config.storagePath, id));
          } catch (error) {
            request.log.error({ err: error, media_id: id }, '读取 Banner 图片文件失败');
            throw new ApiError(404, 'BANNER_MEDIA_NOT_FOUND', 'Banner 图片暂时不可用');
          }
          return reply
            .header('content-type', 'image/webp')
            .header('x-content-type-options', 'nosniff')
            .header('cache-control', admin ? 'no-store' : 'public, max-age=3600, must-revalidate')
            .send(bytes);
        }),
    );
  }
}
