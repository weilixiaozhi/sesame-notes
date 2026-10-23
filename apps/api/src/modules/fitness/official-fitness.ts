import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type OfficialFitnessContent, type PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { FastifyInstance } from 'fastify';
import type { ApiConfig } from '../../shared/api-config.js';
import { ApiError } from '../../shared/errors.js';
import { execute } from '../../shared/execute.js';
import { authenticateAdmin, verifyAdminWriteRequest, withAdminMutation, writeAuditLog } from '../admin/index.js';
import type { FitnessLibrary } from './fitness-library-schemas.js';
import {
  FitnessCatalogSchema,
  officialRowSchema,
  officialSchemas,
  type OfficialKind,
  type OfficialExercise,
} from './official-fitness-schemas.js';
import builtinMedia from './fitness-media-catalog.json' with { type: 'json' };
import { advanceOfficialContentVersion } from './official-fitness-state.js';
import {
  publicFitnessTaxon,
  registerOfficialFitnessTaxonomyRoutes,
  validateOfficialTaxonomies,
} from './official-fitness-taxonomies.js';

type Content = Record<string, unknown>;
const pageQuery = Type.Object(
  {
    q: Type.Optional(Type.String({ maxLength: 200 })),
    page: Type.Optional(Type.Integer({ minimum: 1 })),
    page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);
const idParams = Type.Object({ content_id: Type.String({ minLength: 1, maxLength: 128 }) });
const versionSchema = Type.Integer({ minimum: 1 });
const transactionExerciseIds = new WeakMap<object, Promise<ReadonlySet<string>>>();

/** 管理页面和客户端读取同一份已保存正文，版本用于阻止覆盖并发修改。 */
export function officialResponse(row: OfficialFitnessContent) {
  return {
    id: row.id,
    kind: row.kind,
    version: row.version,
    content: row.content,
    is_enabled: row.isEnabled,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    updated_by: row.updatedBy,
  };
}

/** 正文身份永久由服务器分配，模板和计划修订号在保存时前进。 */
export function normalizeOfficialContent(kind: OfficialKind, value: Content, id: string, revision = 1): Content {
  const content: Content = { ...value, id, ...(kind === 'exercise' ? {} : { revision }) };
  if (!Value.Check(officialSchemas[kind], content))
    throw new ApiError(400, 'FITNESS_CONTENT_INVALID', '官方内容字段不完整或格式不正确');
  /** JSONB 无法表示空字符或未配对代理项，文本必填项也不能仅由空白构成。 */
  function validateText(node: unknown, key = ''): void {
    if (typeof node === 'string') {
      if (
        !node.isWellFormed() ||
        node.includes('\u0000') ||
        (!['attribution', 'gif_asset'].includes(key) && !node.trim())
      )
        throw new ApiError(400, 'FITNESS_CONTENT_INVALID', '官方内容包含空白必填项或无效字符');
    } else if (Array.isArray(node)) node.forEach((entry) => validateText(entry, key));
    else if (node && typeof node === 'object')
      for (const [field, child] of Object.entries(node)) validateText(child, field);
  }
  validateText(content);
  if (kind === 'plan') {
    const plan = content as unknown as FitnessLibrary['plans'][number];
    if (
      plan.days.length !== plan.cycle_days ||
      new Set(plan.days.map((day) => day.day_index)).size !== plan.cycle_days ||
      plan.days.some((day) => day.day_index >= plan.cycle_days) ||
      !plan.days.some((day) => day.template_id !== null)
    )
      throw new ApiError(400, 'FITNESS_PLAN_SCHEDULE_INVALID', '计划必须覆盖整个周期并至少安排一次训练');
  }
  if (kind === 'template') {
    const template = content as unknown as FitnessLibrary['templates'][number];
    if (
      template.exercises.some((exercise) => (exercise.weight_mode === 'body_weight') !== (exercise.weight_kg === null))
    )
      throw new ApiError(400, 'FITNESS_TEMPLATE_WEIGHT_INVALID', '自重动作不填写重量，其他重量模式需要填写重量');
  }
  return content;
}

/** 保存前校验所有引用，停用历史内容时也不能留下当前官方库的悬空引用。 */
export async function validateOfficialContent(
  tx: Prisma.TransactionClient,
  row: Pick<OfficialFitnessContent, 'id' | 'kind' | 'content' | 'isEnabled'>,
): Promise<void> {
  const content = row.content as Content;
  await validateOfficialTaxonomies(tx, row.kind, content);
  const active = await tx.officialFitnessContent.findMany({
    where: { isEnabled: true },
  });
  if (row.kind === 'exercise') {
    const exercise = content as OfficialExercise;
    if (exercise.media_id) {
      if (!(await tx.officialFitnessMedia.findUnique({ where: { id: exercise.media_id } })))
        throw new ApiError(400, 'FITNESS_MEDIA_NOT_FOUND', '动作素材不存在，请重新上传');
    } else if (!Object.values(builtinMedia).includes(exercise.gif_asset)) {
      throw new ApiError(400, 'FITNESS_MEDIA_NOT_FOUND', '请选择有效的动作 GIF 素材');
    }
    if (
      !row.isEnabled &&
      active.some(
        (item) =>
          item.kind === 'template' &&
          (item.content as unknown as FitnessLibrary['templates'][number]).exercises.some(
            (exercise) => exercise.exercise_id === row.id,
          ),
      )
    )
      throw new ApiError(409, 'FITNESS_CONTENT_REFERENCED', '动作仍被启用的训练模板引用，请先调整模板');
  }
  if (row.kind === 'template') {
    const template = content as unknown as FitnessLibrary['templates'][number];
    if (
      row.isEnabled &&
      template.exercises.some(
        (exercise) => !active.some((item) => item.kind === 'exercise' && item.id === exercise.exercise_id),
      )
    )
      throw new ApiError(409, 'FITNESS_REFERENCE_UNAVAILABLE', '模板引用的动作不存在或已停用');
    if (
      !row.isEnabled &&
      active.some(
        (item) =>
          item.kind === 'plan' &&
          (item.content as unknown as FitnessLibrary['plans'][number]).days.some((day) => day.template_id === row.id),
      )
    )
      throw new ApiError(409, 'FITNESS_CONTENT_REFERENCED', '模板仍被启用的训练计划引用，请先调整计划');
  }
  if (
    row.kind === 'plan' &&
    row.isEnabled &&
    (content as unknown as FitnessLibrary['plans'][number]).days.some(
      (day) =>
        day.template_id !== null && !active.some((item) => item.kind === 'template' && item.id === day.template_id),
    )
  )
    throw new ApiError(409, 'FITNESS_REFERENCE_UNAVAILABLE', '计划引用的模板不存在或已停用');
}

/** 一次读取同一快照中的版本与正文，避免并发保存生成不一致缓存。 */
export async function readOfficialContent(prisma: PrismaClient) {
  return prisma.$transaction(
    async (tx) => ({
      version: (await tx.officialFitnessState.findUnique({ where: { id: 1 } }))?.contentVersion ?? 1,
      rows: await tx.officialFitnessContent.findMany({ orderBy: { id: 'asc' } }),
      taxonomies: await tx.officialFitnessTaxon.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    }),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

/** 已保存动作进入同步身份白名单；停用只影响选择入口，历史记录仍可同步。 */
export async function officialExerciseIds(
  tx: Pick<Prisma.TransactionClient, 'officialFitnessContent'>,
): Promise<ReadonlySet<string>> {
  const cached = transactionExerciseIds.get(tx);
  if (cached) return cached;
  // 一个导入事务可含数百条记录，事务对象结束后弱引用自动释放。
  const reading = tx.officialFitnessContent
    .findMany({
      where: { kind: 'exercise' },
      select: { id: true },
    })
    .then((rows) => new Set(rows.map((row) => row.id)));
  transactionExerciseIds.set(tx, reading);
  try {
    return await reading;
  } catch (error) {
    transactionExerciseIds.delete(tx);
    throw error;
  }
}

/** 内置文件仅可使用审核清单的路径，上传文件通过内容哈希引用。 */
function officialMediaUrl(exercise: OfficialExercise): string {
  const builtinId = Object.entries(builtinMedia).find(([, path]) => path === exercise.gif_asset)?.[0];
  return `/api/v1/fitness/media/${exercise.media_id ?? `builtin-${builtinId ?? exercise.id}`}`;
}

/** 为公开内容生成实体标签，浏览器和 App 可按正文变化复用缓存。 */
export function contentEtag(value: unknown): string {
  return `"fitness-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)}"`;
}

/** 后台目录使用身份事务保护写入、版本检查和审计的原子性。 */
export function registerOfficialFitnessRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  registerOfficialFitnessTaxonomyRoutes(app, prisma, config);
  const referenceSchema = Type.Array(
    Type.Object({ id: Type.String(), name: Type.String(), is_enabled: Type.Boolean() }),
  );
  app.get(
    '/api/v1/admin/fitness/references',
    {
      onRequest: verifyAdminWriteRequest(config),
      preHandler: authenticateAdmin(config, prisma, 'fitness:read'),
      schema: {
        tags: ['admin-fitness'],
        operationId: 'listOfficialFitnessReferences',
        response: { 200: Type.Object({ exercises: referenceSchema, templates: referenceSchema }) },
      },
    },
    async (request) =>
      execute(request, '读取官方内容引用', async () => {
        const rows = await prisma.officialFitnessContent.findMany({
          where: { kind: { in: ['exercise', 'template'] } },
          orderBy: { id: 'asc' },
        });
        /** 选择与历史显示只需要身份、名称和启用状态，不传输大段教学正文。 */
        const references = (kind: 'exercise' | 'template') =>
          rows
            .filter((row) => row.kind === kind)
            .map((row) => ({
              id: row.id,
              name:
                kind === 'exercise'
                  ? (row.content as unknown as OfficialExercise).name_zh
                  : (row.content as unknown as FitnessLibrary['templates'][number]).name.zh,
              is_enabled: row.isEnabled,
            }));
        return { exercises: references('exercise'), templates: references('template') };
      }),
  );
  for (const [kind, collection] of [
    ['exercise', 'exercises'],
    ['template', 'templates'],
    ['plan', 'plans'],
  ] as const) {
    const schema = officialSchemas[kind];
    const editable =
      kind === 'exercise'
        ? Type.Omit(officialSchemas.exercise, ['id'])
        : kind === 'template'
          ? Type.Omit(officialSchemas.template, ['id', 'revision'])
          : Type.Omit(officialSchemas.plan, ['id', 'revision']);
    const rowSchema = officialRowSchema(schema);
    const base = `/api/v1/admin/fitness/${collection}`;
    const readGuard = {
      onRequest: verifyAdminWriteRequest(config),
      preHandler: authenticateAdmin(config, prisma, 'fitness:read'),
    };
    const writeGuard = {
      onRequest: verifyAdminWriteRequest(config),
      preHandler: authenticateAdmin(config, prisma, 'fitness:write'),
    };
    app.get(
      base,
      {
        ...readGuard,
        schema: {
          tags: ['admin-fitness'],
          operationId: `listOfficial${collection[0]!.toUpperCase()}${collection.slice(1)}`,
          querystring: pageQuery,
          response: {
            200: Type.Object({
              items: Type.Array(rowSchema),
              page: Type.Integer(),
              page_size: Type.Integer(),
              total: Type.Integer(),
              next_cursor: Type.Null(),
            }),
          },
        },
      },
      async (request) =>
        execute(request, '读取官方健身内容', async () => {
          const query = request.query as { q?: string; page?: number; page_size?: number };
          const where: Prisma.OfficialFitnessContentWhereInput = {
            kind,
            ...(query.q?.trim()
              ? {
                  content: {
                    path: kind === 'exercise' ? ['name_zh'] : ['name', 'zh'],
                    string_contains: query.q.trim(),
                  },
                }
              : {}),
          };
          return prisma.$transaction(
            async (tx) => {
              const total = await tx.officialFitnessContent.count({ where });
              const pageSize = query.page_size ?? 20;
              const page = Math.min(query.page ?? 1, Math.max(1, Math.ceil(total / pageSize)));
              const rows = await tx.officialFitnessContent.findMany({
                where,
                orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
                skip: (page - 1) * pageSize,
                take: pageSize,
              });
              return { items: rows.map(officialResponse), page, page_size: pageSize, total, next_cursor: null };
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
          );
        }),
    );
    app.post(
      base,
      {
        ...writeGuard,
        schema: {
          tags: ['admin-fitness'],
          body: Type.Object(
            { content: editable, is_enabled: Type.Optional(Type.Boolean()) },
            { additionalProperties: false },
          ),
          response: { 201: rowSchema },
        },
      },
      async (request, reply) =>
        execute(request, '新增官方健身内容', async () => {
          const body = request.body as { content: Content; is_enabled?: boolean };
          const id = randomUUID();
          const content = normalizeOfficialContent(kind, body.content, id);
          const row = await withAdminMutation(prisma, request, 'fitness:write', async (tx, auth) => {
            const isEnabled = body.is_enabled ?? true;
            await validateOfficialContent(tx, { id, kind, content: content as Prisma.JsonObject, isEnabled });
            const result = await tx.officialFitnessContent.create({
              data: {
                id,
                kind,
                content: content as Prisma.InputJsonObject,
                isEnabled,
                updatedBy: auth.username,
              },
            });
            await advanceOfficialContentVersion(tx);
            await writeAuditLog(tx, {
              actor: `admin:${auth.adminId}`,
              action: `fitness.${kind}.create`,
              target: { type: `fitness_${kind}`, id },
              requestId: request.id,
              ip: request.ip,
              metadata: { enabled: isEnabled },
            });
            return result;
          });
          return reply.code(201).send(officialResponse(row));
        }),
    );
    app.patch(
      `${base}/:content_id`,
      {
        ...writeGuard,
        schema: {
          tags: ['admin-fitness'],
          params: idParams,
          body: Type.Object(
            { version: versionSchema, content: Type.Optional(editable), is_enabled: Type.Optional(Type.Boolean()) },
            { additionalProperties: false },
          ),
          response: { 200: rowSchema },
        },
      },
      async (request) =>
        execute(request, '修改官方健身内容', async () => {
          const { content_id: id } = request.params as { content_id: string };
          const body = request.body as { version: number; content?: Content; is_enabled?: boolean };
          return withAdminMutation(prisma, request, 'fitness:write', async (tx, auth) => {
            const current = await requireOfficialVersion(tx, kind, id, body.version);
            const content = normalizeOfficialContent(
              kind,
              body.content ?? (current.content as Content),
              id,
              Number((current.content as Content).revision ?? 0) + 1,
            );
            const isEnabled = body.is_enabled ?? current.isEnabled;
            await validateOfficialContent(tx, { id, kind, content: content as Prisma.JsonObject, isEnabled });
            const result = await tx.officialFitnessContent.update({
              where: { id },
              data: {
                content: content as Prisma.InputJsonObject,
                isEnabled,
                version: { increment: 1 },
                updatedBy: auth.username,
              },
            });
            await advanceOfficialContentVersion(tx);
            await writeAuditLog(tx, {
              actor: `admin:${auth.adminId}`,
              action: `fitness.${kind}.update`,
              target: { type: `fitness_${kind}`, id },
              requestId: request.id,
              ip: request.ip,
              metadata: { enabled: isEnabled },
            });
            return officialResponse(result);
          });
        }),
    );
  }
  app.get(
    '/api/v1/fitness/catalog',
    {
      schema: {
        tags: ['fitness'],
        operationId: 'getFitnessCatalog',
        response: { 200: FitnessCatalogSchema, 304: Type.Null() },
      },
    },
    async (request, reply) =>
      execute(request, '读取官方动作目录', async () => {
        const { version, rows, taxonomies } = await readOfficialContent(prisma);
        const result = {
          schema_version: 1 as const,
          content_version: version,
          taxonomies: {
            body_parts: taxonomies.filter((row) => row.kind === 'body_part').map(publicFitnessTaxon),
            equipment: taxonomies.filter((row) => row.kind === 'equipment').map(publicFitnessTaxon),
          },
          exercises: rows
            .filter((row) => row.kind === 'exercise')
            .map((row) => ({
              ...(row.content as unknown as OfficialExercise),
              media_url: officialMediaUrl(row.content as unknown as OfficialExercise),
              is_enabled: row.isEnabled,
            })),
        };
        const etag = contentEtag(result);
        reply.header('etag', etag).header('cache-control', 'public, max-age=60, stale-if-error=86400');
        if (request.headers['if-none-match'] === etag) return reply.code(304).send();
        return result;
      }),
  );
}

/** 检查客户端编辑时看到的版本，拒绝把他人的新修改覆盖。 */
export async function requireOfficialVersion(
  tx: Prisma.TransactionClient,
  kind: OfficialKind,
  id: string,
  version: number,
) {
  const row = await tx.officialFitnessContent.findUnique({ where: { id } });
  if (!row || row.kind !== kind) throw new ApiError(404, 'FITNESS_CONTENT_NOT_FOUND', '官方内容不存在');
  if (row.version !== version) throw new ApiError(409, 'FITNESS_CONTENT_CHANGED', '内容已被其他人修改，请刷新后重试');
  return row;
}
