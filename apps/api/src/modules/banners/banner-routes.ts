import { readFile } from 'node:fs/promises';
import { Prisma, type PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { ApiConfig } from '../../shared/api-config.js';
import { ApiError } from '../../shared/errors.js';
import { execute } from '../../shared/execute.js';
import { authenticateAdmin, verifyAdminWriteRequest, withAdminMutation, writeAuditLog } from '../admin/index.js';
import { bannerMediaFile, MAX_BANNER_BYTES, publishBannerMedia, validateBannerImage } from './banner-media.js';
import {
  activeBannerWhere,
  adminBannerResponse,
  assertBannerCapacity,
  bannerOrder,
  bannerSlideResponse,
  bannerTargetNames,
  builtinBannerResponse,
  editableBanner,
  officialBannerName,
  validateBannerContent,
} from './banner-management.js';
import {
  BANNER_SLOTS,
  AdminBannerEntrySchema,
  AdminBannerListSchema,
  BannerCarouselSchema,
  BannerCreateSchema,
  BannerDeleteSchema,
  BannerIdSchema,
  BannerListSchema,
  BannerMediaIdSchema,
  BannerResetSchema,
  BannerSlotSchema,
  BannerTargetOptionsSchema,
  BannerUpdateSchema,
  BannerUploadResponseSchema,
  type BannerCreate,
  type BannerReset,
  type BannerSlot,
  type BannerUpdate,
} from './banner-schemas.js';

const slotNames: Record<BannerSlot, string> = {
  'fitness-plan-library': '计划库入口',
  'fitness-template-library': '模板库入口',
};
const idParams = Type.Object({ banner_id: BannerIdSchema });
const okSchema = Type.Object({ ok: Type.Literal(true) });
type AdminBannerDisplay = ReturnType<typeof adminBannerResponse> | ReturnType<typeof builtinBannerResponse>;

/** 公开配置按显式格式返回；旧客户端每个位置只得到首张及其可识别的库入口。 */
export function registerBannerRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  app.get(
    '/api/v1/banners',
    {
      schema: {
        tags: ['banners'],
        operationId: 'getAppBanners',
        querystring: Type.Object({ format: Type.Optional(Type.Literal('carousel')) }, { additionalProperties: false }),
        response: { 200: Type.Union([BannerListSchema, BannerCarouselSchema]) },
      },
    },
    async (request, reply) =>
      execute(request, '读取应用 Banner', async () => {
        const carousel = (request.query as { format?: string }).format === 'carousel';
        const items = await prisma.$transaction(
          async (tx) => {
            const rows = await tx.appBanner.findMany({ where: activeBannerWhere, orderBy: [...bannerOrder] });
            const names = await bannerTargetNames(tx, rows, true);
            const available = rows.filter(
              (row) => row.imageId && (!row.targetId || names.has(`${row.target}:${row.targetId}`)),
            );
            if (carousel) return available.map((row) => bannerSlideResponse(row, names));
            return BANNER_SLOTS.flatMap((slot) => {
              const row = available.find((item) => item.slot === slot);
              if (!row) return [];
              return [
                {
                  slot,
                  image_path: `/api/v1/banners/media/${row.imageId}`,
                  target:
                    row.target === 'official-plan'
                      ? 'fitness-plan-library'
                      : row.target === 'official-template'
                        ? 'fitness-template-library'
                        : row.target,
                  is_enabled: true,
                  version: row.version,
                  updated_at: row.updatedAt.toISOString(),
                },
              ];
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        );
        reply.header('cache-control', 'no-store');
        return { items };
      }),
  );
  app.get(
    '/api/v1/admin/banners',
    {
      preHandler: authenticateAdmin(config, prisma, 'banners:read'),
      schema: { tags: ['admin-banners'], operationId: 'listAdminBanners', response: { 200: AdminBannerListSchema } },
    },
    async (request) =>
      execute(request, '查询 Banner 图片', async () =>
        prisma.$transaction(
          async (tx) => {
            const rows = await tx.appBanner.findMany({ where: activeBannerWhere, orderBy: [...bannerOrder] });
            const names = await bannerTargetNames(tx, rows);
            return {
              items: BANNER_SLOTS.flatMap<AdminBannerDisplay>((slot) => {
                const selected = rows.filter((row) => row.slot === slot);
                return selected.length
                  ? selected.map((row) => adminBannerResponse(row, names))
                  : [builtinBannerResponse(slot)];
              }),
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        ),
      ),
  );
  app.get(
    '/api/v1/admin/banners/targets',
    {
      preHandler: authenticateAdmin(config, prisma, 'banners:read'),
      schema: {
        tags: ['admin-banners'],
        operationId: 'listAdminBannerTargets',
        querystring: Type.Object(
          {
            kind: Type.Union([Type.Literal('plan'), Type.Literal('template')]),
            q: Type.Optional(Type.String({ maxLength: 100 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: BannerTargetOptionsSchema },
      },
    },
    async (request) =>
      execute(request, '查询 Banner 跳转内容', async () => {
        const query = request.query as { kind: 'plan' | 'template'; q?: string };
        const rows = await prisma.officialFitnessContent.findMany({
          where: {
            kind: query.kind,
            isEnabled: true,
            ...(query.q?.trim() ? { content: { path: ['name', 'zh'], string_contains: query.q.trim() } } : {}),
          },
          orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
          take: 100,
          select: { id: true, content: true },
        });
        return {
          items: rows.flatMap((row) => {
            const name = officialBannerName(row.content);
            return name ? [{ id: row.id, name }] : [];
          }),
        };
      }),
  );
  app.post(
    '/api/v1/admin/banners',
    {
      onRequest: verifyAdminWriteRequest(config),
      preHandler: authenticateAdmin(config, prisma, 'banners:write'),
      schema: {
        tags: ['admin-banners'],
        operationId: 'createAdminBanner',
        body: BannerCreateSchema,
        response: { 201: AdminBannerEntrySchema },
      },
    },
    async (request, reply) =>
      execute(request, '新增 Banner 图片', async () => {
        const body = request.body as BannerCreate;
        const response = await withAdminMutation(prisma, request, 'banners:write', async (tx, auth) => {
          await validateBannerContent(tx, body);
          await assertBannerCapacity(tx, body.slot);
          const row = await tx.appBanner.create({
            data: {
              slot: body.slot,
              imageId: body.image_id,
              target: body.target,
              targetId: body.target_id,
              sortOrder: body.sort_order,
              isEnabled: true,
              updatedBy: auth.username,
            },
          });
          await writeAuditLog(tx, {
            actor: `admin:${auth.adminId}`,
            action: 'banner.create',
            target: { type: 'app_banner', id: row.id },
            requestId: request.id,
            ip: request.ip,
            metadata: { slot: row.slot, version: row.version },
          });
          return adminBannerResponse(row, await bannerTargetNames(tx, [row]));
        });
        return reply.code(201).send(response);
      }),
  );
  app.patch(
    '/api/v1/admin/banners/:banner_id',
    {
      onRequest: verifyAdminWriteRequest(config),
      preHandler: authenticateAdmin(config, prisma, 'banners:write'),
      schema: {
        tags: ['admin-banners'],
        operationId: 'updateAdminBanner',
        params: idParams,
        body: BannerUpdateSchema,
        response: { 200: AdminBannerEntrySchema },
      },
    },
    async (request) =>
      execute(request, '修改 Banner 图片', async () => {
        const { banner_id: id } = request.params as { banner_id: string };
        const body = request.body as BannerUpdate;
        return withAdminMutation(prisma, request, 'banners:write', async (tx, auth) => {
          await editableBanner(tx, id, body.version);
          await validateBannerContent(tx, body);
          await assertBannerCapacity(tx, body.slot, id);
          const row = await tx.appBanner.update({
            where: { id, version: body.version },
            data: {
              slot: body.slot,
              imageId: body.image_id,
              target: body.target,
              targetId: body.target_id,
              sortOrder: body.sort_order,
              updatedBy: auth.username,
              version: { increment: 1 },
            },
          });
          await writeAuditLog(tx, {
            actor: `admin:${auth.adminId}`,
            action: 'banner.update',
            target: { type: 'app_banner', id },
            requestId: request.id,
            ip: request.ip,
            metadata: { slot: row.slot, version: row.version },
          });
          return adminBannerResponse(row, await bannerTargetNames(tx, [row]));
        });
      }),
  );
  app.delete(
    '/api/v1/admin/banners/:banner_id',
    {
      onRequest: verifyAdminWriteRequest(config),
      preHandler: authenticateAdmin(config, prisma, 'banners:write'),
      schema: {
        tags: ['admin-banners'],
        operationId: 'deleteAdminBanner',
        params: idParams,
        body: BannerDeleteSchema,
        response: { 200: okSchema },
      },
    },
    async (request) =>
      execute(request, '移除 Banner 图片', async () => {
        const { banner_id: id } = request.params as { banner_id: string };
        const { version } = request.body as { version: number };
        return withAdminMutation(prisma, request, 'banners:write', async (tx, auth) => {
          const row = await editableBanner(tx, id, version);
          await tx.appBanner.update({
            where: { id, version },
            data: {
              deletedAt: new Date(),
              isEnabled: false,
              updatedBy: auth.username,
              version: { increment: 1 },
            },
          });
          await writeAuditLog(tx, {
            actor: `admin:${auth.adminId}`,
            action: 'banner.delete',
            target: { type: 'app_banner', id },
            requestId: request.id,
            ip: request.ip,
            metadata: { slot: row.slot },
          });
          return { ok: true as const };
        });
      }),
  );
  app.post(
    '/api/v1/admin/banners/:slot/reset',
    {
      onRequest: verifyAdminWriteRequest(config),
      preHandler: authenticateAdmin(config, prisma, 'banners:write'),
      schema: {
        tags: ['admin-banners'],
        operationId: 'resetAdminBannerSlot',
        params: Type.Object({ slot: BannerSlotSchema }),
        body: BannerResetSchema,
        response: { 200: okSchema },
      },
    },
    async (request) =>
      execute(request, '恢复 Banner 默认图片', async () => {
        const { slot } = request.params as { slot: BannerSlot };
        const body = request.body as BannerReset;
        return withAdminMutation(prisma, request, 'banners:write', async (tx, auth) => {
          const rows = await tx.appBanner.findMany({ where: { ...activeBannerWhere, slot } });
          const requested = new Map(body.revisions.map((row) => [row.id, row.version]));
          // 必须与管理员看到的完整位置快照一致，不能悄悄清除后来新增或修改的图片。
          if (
            requested.size !== body.revisions.length ||
            rows.length !== requested.size ||
            rows.some((row) => requested.get(row.id) !== row.version)
          )
            throw new ApiError(409, 'BANNER_VERSION_CONFLICT', '此位置的图片已变化，请刷新并确认后重试');
          if (rows.length)
            await tx.appBanner.updateMany({
              where: { ...activeBannerWhere, slot },
              data: { deletedAt: new Date(), isEnabled: false, updatedBy: auth.username, version: { increment: 1 } },
            });
          await writeAuditLog(tx, {
            actor: `admin:${auth.adminId}`,
            action: 'banner.reset',
            target: { type: 'app_banner_slot', id: slot },
            requestId: request.id,
            ip: request.ip,
            metadata: { count: rows.length, target_display: slotNames[slot] },
          });
          return { ok: true as const };
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
            (await prisma.appBanner.findFirst({
              where: { imageId: id, isEnabled: true, deletedAt: null },
              select: { slot: true },
            }));
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
