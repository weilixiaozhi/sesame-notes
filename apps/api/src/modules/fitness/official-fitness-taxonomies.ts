import { randomUUID } from 'node:crypto';

import { Prisma, type OfficialFitnessContent, type OfficialFitnessTaxon, type PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import type { ApiConfig } from '../../shared/api-config.js';
import { ApiError } from '../../shared/errors.js';
import { execute } from '../../shared/execute.js';
import {
  adminOperationReason,
  AdminReasonSchema,
  authenticateAdmin,
  withAdminMutation,
  writeAuditLog,
} from '../admin/index.js';
import { advanceOfficialContentVersion } from './official-fitness-state.js';
import {
  AdminFitnessTaxonSchema,
  FitnessTaxonKindSchema,
  FitnessTaxonNameSchema,
  type FitnessTaxonKind,
  type FitnessTaxonName,
} from './official-fitness-taxonomy-schemas.js';

type TaxonParams = { kind: FitnessTaxonKind; taxon_id: string };
type TaxonReferences = { exercises: OfficialFitnessContent[]; templates: OfficialFitnessContent[] };
const sortSchema = Type.Integer({ minimum: 0, maximum: 9999 });
const idSchema = Type.String({ minLength: 1, maxLength: 100 });
const versionSchema = Type.Integer({ minimum: 1 });
const kindParams = Type.Object({ kind: FitnessTaxonKindSchema });
const taxonParams = Type.Object({ kind: FitnessTaxonKindSchema, taxon_id: idSchema });

/** 公共目录保留软删除项的名称，历史训练仍能显示正确标签。 */
export function publicFitnessTaxon(row: OfficialFitnessTaxon) {
  return {
    id: row.id,
    name: { zh: row.nameZh, zh_hant: row.nameHant, en: row.nameEn },
    is_deleted: row.deletedAt !== null,
  };
}

/** 后台统计包含全部官方引用，停用内容也必须参与删除前的替换。 */
function taxonResponse(row: OfficialFitnessTaxon, references: TaxonReferences) {
  return {
    ...publicFitnessTaxon(row),
    kind: row.kind,
    sort_order: row.sortOrder,
    version: row.version,
    exercise_count: references.exercises.length,
    template_count: references.templates.length,
  };
}

/** 按正文的实际字段收集引用，不把模板动作间接依赖重复计入模板器械。 */
function fitnessTaxonReferences(rows: OfficialFitnessContent[], kind: FitnessTaxonKind, id: string) {
  const exercises: OfficialFitnessContent[] = [];
  const templates: OfficialFitnessContent[] = [];
  for (const row of rows) {
    const content = row.content as Record<string, unknown>;
    if (row.kind === 'exercise' && content[kind] === id) exercises.push(row);
    if (row.kind === 'template' && kind === 'equipment' && Array.isArray(content.equipment)) {
      if (content.equipment.includes(id)) templates.push(row);
    }
  }
  return { exercises, templates };
}

/** 多语言名称必须是可保存的非空文本，标识始终由服务器单独生成。 */
function normalizeTaxonName(name: FitnessTaxonName) {
  const values = [name.zh, name.zh_hant, name.en];
  if (values.some((value) => !value.trim() || !value.isWellFormed() || value.includes('\u0000'))) {
    throw new ApiError(400, 'FITNESS_TAXON_NAME_INVALID', '请填写有效的分类名称');
  }
  return { nameZh: name.zh.trim(), nameHant: name.zh_hant.trim(), nameEn: name.en.trim() };
}

/** 保存时只允许当前有效字典身份，旧编辑表单不能重新写回已删除分类。 */
export async function validateOfficialTaxonomies(
  tx: Prisma.TransactionClient,
  kind: string,
  content: Record<string, unknown>,
): Promise<void> {
  try {
    const requested: Array<{ kind: FitnessTaxonKind; id: string }> = [];
    if (kind === 'exercise') {
      requested.push({ kind: 'body_part', id: content.body_part as string });
      requested.push({ kind: 'equipment', id: content.equipment as string });
    } else if (kind === 'template') {
      requested.push(...(content.equipment as string[]).map((id) => ({ kind: 'equipment' as const, id })));
    }
    if (!requested.length) return;
    const rows = await tx.officialFitnessTaxon.findMany({ where: { OR: requested, deletedAt: null } });
    if (requested.some((entry) => !rows.some((row) => row.kind === entry.kind && row.id === entry.id))) {
      throw new ApiError(409, 'FITNESS_TAXON_UNAVAILABLE', '部位或器械已删除或不存在，请刷新分类后重新选择');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('官方健身分类校验失败', { cause: error });
  }
}

/** 版本在后台安全事务内读取，避免删除或重命名覆盖其他管理员的修改。 */
async function requireTaxonVersion(tx: Prisma.TransactionClient, kind: FitnessTaxonKind, id: string, version: number) {
  const row = await tx.officialFitnessTaxon.findUnique({ where: { kind_id: { kind, id } } });
  if (!row || row.deletedAt) throw new ApiError(404, 'FITNESS_TAXON_NOT_FOUND', '部位或器械不存在');
  if (row.version !== version) throw new ApiError(409, 'FITNESS_TAXON_CHANGED', '分类已被其他人修改，请刷新后重试');
  return row;
}

/** 删除前原子迁移官方引用，内容版本与模板修订一并推进，用户训练记录保持原身份。 */
async function replaceTaxonReferences(
  tx: Prisma.TransactionClient,
  references: TaxonReferences,
  kind: FitnessTaxonKind,
  id: string,
  replacement: string,
  username: string,
): Promise<void> {
  try {
    for (const row of [...references.exercises, ...references.templates]) {
      const content = row.content as Record<string, unknown>;
      // 模板可能同时包含原分类和替代分类；保留原顺序并去重，防止重复器械违反正文约束。
      const next =
        row.kind === 'template'
          ? {
              ...content,
              equipment: [
                ...new Set((content.equipment as string[]).map((entry) => (entry === id ? replacement : entry))),
              ],
              revision: Number(content.revision) + 1,
            }
          : { ...content, [kind]: replacement };
      await tx.officialFitnessContent.update({
        where: { id: row.id },
        data: { content: next as Prisma.InputJsonObject, version: { increment: 1 }, updatedBy: username },
      });
    }
  } catch (cause) {
    throw new Error('官方健身分类引用替换失败', { cause });
  }
}

/** 注册部位与器械管理；分类、引用正文、版本及审计始终同事务提交。 */
export function registerOfficialFitnessTaxonomyRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  config: ApiConfig,
): void {
  try {
    const base = '/api/v1/admin/fitness/taxonomies/:kind';
    app.get(
      base,
      {
        preHandler: authenticateAdmin(config, prisma, 'fitness:read'),
        schema: {
          tags: ['admin-fitness'],
          operationId: 'listOfficialFitnessTaxonomies',
          params: kindParams,
          response: { 200: Type.Object({ items: Type.Array(AdminFitnessTaxonSchema) }) },
        },
      },
      async (request) =>
        execute(request, '读取健身分类', async () => {
          const { kind } = request.params as TaxonParams;
          return prisma.$transaction(
            async (tx) => {
              const taxonomies = await tx.officialFitnessTaxon.findMany({
                where: { kind },
                orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
              });
              const rows = await tx.officialFitnessContent.findMany({
                where: { kind: { in: ['exercise', 'template'] } },
              });
              return { items: taxonomies.map((row) => taxonResponse(row, fitnessTaxonReferences(rows, kind, row.id))) };
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
          );
        }),
    );
    app.post(
      base,
      {
        preHandler: authenticateAdmin(config, prisma, 'fitness:write'),
        schema: {
          tags: ['admin-fitness'],
          operationId: 'createOfficialFitnessTaxonomy',
          params: kindParams,
          body: Type.Object(
            { name: FitnessTaxonNameSchema, sort_order: Type.Optional(sortSchema), reason: AdminReasonSchema },
            { additionalProperties: false },
          ),
          response: { 201: AdminFitnessTaxonSchema },
        },
      },
      async (request, reply) =>
        execute(request, '新增健身分类', async () => {
          const { kind } = request.params as TaxonParams;
          const body = request.body as { name: FitnessTaxonName; sort_order?: number; reason: string };
          const reason = adminOperationReason(body);
          const name = normalizeTaxonName(body.name);
          const row = await withAdminMutation(prisma, request, 'fitness:write', async (tx, auth) => {
            const created = await tx.officialFitnessTaxon.create({
              data: { kind, id: randomUUID(), ...name, sortOrder: body.sort_order ?? 0, updatedBy: auth.username },
            });
            await advanceOfficialContentVersion(tx);
            await writeAuditLog(tx, {
              actor: `admin:${auth.adminId}`,
              action: 'fitness.taxonomy.create',
              target: { type: 'fitness_taxonomy', id: created.id },
              requestId: request.id,
              ip: request.ip,
              metadata: { reason, kind, taxon_name: created.nameZh, target_display: created.nameZh },
            });
            return created;
          });
          return reply.code(201).send(taxonResponse(row, { exercises: [], templates: [] }));
        }),
    );
    app.patch(
      `${base}/:taxon_id`,
      {
        preHandler: authenticateAdmin(config, prisma, 'fitness:write'),
        schema: {
          tags: ['admin-fitness'],
          operationId: 'updateOfficialFitnessTaxonomy',
          params: taxonParams,
          body: Type.Object(
            {
              version: versionSchema,
              name: Type.Optional(FitnessTaxonNameSchema),
              sort_order: Type.Optional(sortSchema),
              reason: AdminReasonSchema,
            },
            { additionalProperties: false },
          ),
          response: { 200: AdminFitnessTaxonSchema },
        },
      },
      async (request) =>
        execute(request, '修改健身分类', async () => {
          const { kind, taxon_id: id } = request.params as TaxonParams;
          const body = request.body as {
            version: number;
            name?: FitnessTaxonName;
            sort_order?: number;
            reason: string;
          };
          const reason = adminOperationReason(body);
          if (body.name === undefined && body.sort_order === undefined)
            throw new ApiError(400, 'FITNESS_TAXON_UPDATE_EMPTY', '请修改分类名称或排序后保存');
          const name = body.name ? normalizeTaxonName(body.name) : {};
          return withAdminMutation(prisma, request, 'fitness:write', async (tx, auth) => {
            await requireTaxonVersion(tx, kind, id, body.version);
            const row = await tx.officialFitnessTaxon.update({
              where: { kind_id: { kind, id } },
              data: { ...name, sortOrder: body.sort_order, version: { increment: 1 }, updatedBy: auth.username },
            });
            await advanceOfficialContentVersion(tx);
            await writeAuditLog(tx, {
              actor: `admin:${auth.adminId}`,
              action: 'fitness.taxonomy.update',
              target: { type: 'fitness_taxonomy', id },
              requestId: request.id,
              ip: request.ip,
              metadata: { reason, kind, taxon_name: row.nameZh, target_display: row.nameZh },
            });
            const rows = await tx.officialFitnessContent.findMany({
              where: { kind: { in: ['exercise', 'template'] } },
            });
            return taxonResponse(row, fitnessTaxonReferences(rows, kind, id));
          });
        }),
    );
    app.delete(
      `${base}/:taxon_id`,
      {
        preHandler: authenticateAdmin(config, prisma, 'fitness:write'),
        schema: {
          tags: ['admin-fitness'],
          operationId: 'deleteOfficialFitnessTaxonomy',
          params: taxonParams,
          body: Type.Object(
            { version: versionSchema, replacement_id: Type.Optional(idSchema), reason: AdminReasonSchema },
            { additionalProperties: false },
          ),
          response: { 204: Type.Null() },
        },
      },
      async (request, reply) =>
        execute(request, '删除健身分类', async () => {
          const { kind, taxon_id: id } = request.params as TaxonParams;
          const body = request.body as { version: number; replacement_id?: string; reason: string };
          const reason = adminOperationReason(body);
          await withAdminMutation(prisma, request, 'fitness:write', async (tx, auth) => {
            const current = await requireTaxonVersion(tx, kind, id, body.version);
            const rows = await tx.officialFitnessContent.findMany({
              where: { kind: { in: ['exercise', 'template'] } },
            });
            const references = fitnessTaxonReferences(rows, kind, id);
            const referenced = references.exercises.length + references.templates.length > 0;
            if (referenced && !body.replacement_id)
              throw new ApiError(409, 'FITNESS_TAXON_REFERENCED', '该分类仍被动作或模板使用，请选择替代分类');
            if (body.replacement_id) {
              const replacement = await tx.officialFitnessTaxon.findUnique({
                where: { kind_id: { kind, id: body.replacement_id } },
              });
              if (!replacement || replacement.deletedAt || replacement.id === id)
                throw new ApiError(400, 'FITNESS_TAXON_REPLACEMENT_INVALID', '请选择同类的有效替代分类');
              await replaceTaxonReferences(tx, references, kind, id, replacement.id, auth.username);
            }
            await tx.officialFitnessTaxon.update({
              where: { kind_id: { kind, id } },
              data: { deletedAt: new Date(), version: { increment: 1 }, updatedBy: auth.username },
            });
            await advanceOfficialContentVersion(tx);
            await writeAuditLog(tx, {
              actor: `admin:${auth.adminId}`,
              action: 'fitness.taxonomy.delete',
              target: { type: 'fitness_taxonomy', id },
              requestId: request.id,
              ip: request.ip,
              metadata: {
                reason,
                kind,
                taxon_name: current.nameZh,
                target_display: current.nameZh,
                replacement_id: body.replacement_id ?? null,
                exercise_count: references.exercises.length,
                template_count: references.templates.length,
              },
            });
          });
          return reply.code(204).send();
        }),
    );
  } catch (cause) {
    throw new Error('官方健身分类接口注册失败', { cause });
  }
}
