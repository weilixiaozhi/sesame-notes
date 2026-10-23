import { Prisma, type Category, type CategoryConflict } from '@prisma/client';
import type { SyncTransaction } from '../../shared/sync-transaction.js';
import { ApiError } from '../../shared/errors.js';
import { categoryState, categoryVersionToken } from '../../shared/category-version.js';
import type { CategoryDraft } from '../../shared/contracts/category-conflicts.js';
import { ANY_UUID_PATTERN } from '../../shared/contracts/scalars.js';
import { normalizeName } from '../../shared/text-validation.js';
import { checkMutationIdentity, reserveMutation } from '../../shared/mutation-reservations.js';
import { validateCategoryFields } from './domain/categories.js';
import identities from './official-category-identities.json' with { type: 'json' };

const official = new Map(identities.items.map((item) => [item.id, item]));

/** 只认正式目录的固定 UUID；不能按名称或 UUID 版本猜测模板来源。 */
export function officialCategoryIdentity(id: string) {
  return official.get(id.toLowerCase());
}

/** 保存候选前校验原始类型与两级树的静态结构，动态父节点在确认时重新核验。 */
export function normalizeCategoryDraft(payload: Record<string, unknown>, categoryId: string): CategoryDraft {
  try {
    const level = payload.level;
    if (level !== 1 && level !== 2) throw new ApiError(400, 'INVALID_CATEGORY_LEVEL', '分类层级无效');
    if (payload.kind !== 'expense') throw new ApiError(400, 'INVALID_CATEGORY_KIND', '分类类型无效');
    const fields = { sort_order: payload.sort_order, icon: payload.icon };
    validateCategoryFields(fields);
    const rawParent = payload.parent_id;
    if (rawParent != null && (typeof rawParent !== 'string' || !new RegExp(ANY_UUID_PATTERN).test(rawParent)))
      throw new ApiError(400, 'INVALID_CATEGORY_PARENT', '父分类身份无效');
    const parentId = typeof rawParent === 'string' ? rawParent.toLowerCase() : null;
    if (parentId === categoryId.toLowerCase()) throw new ApiError(400, 'CATEGORY_CYCLE', '分类不能以自身为父分类');
    // 静态结构不能由其他分类同步恢复，和需要重新查询父节点的依赖错误使用不同编码。
    if (level === 1 && parentId !== null)
      throw new ApiError(400, 'CATEGORY_PARENT_FORBIDDEN', '一级分类不能设置父分类');
    if (level === 2 && parentId === null) throw new ApiError(400, 'CATEGORY_PARENT_REQUIRED', '二级分类必须选择父分类');
    return {
      name: normalizeName(payload.name),
      kind: 'expense',
      level,
      sort_order: fields.sort_order ?? 0,
      icon: fields.icon ?? null,
      parent_id: parentId,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('分类草稿归一化失败', { cause: error });
  }
}

/** 比较用户可见的真实内容与删除状态，不把时间戳或语言名称当作分类身份。 */
export function categoryIntentMatches(
  current: Category,
  action: 'upsert' | 'delete',
  draft: CategoryDraft | null,
): boolean {
  if (action === 'delete') return current.deletedAt !== null;
  if (current.deletedAt !== null || draft === null) return false;
  return (
    current.name === draft.name &&
    current.kind === draft.kind &&
    current.level === draft.level &&
    current.sortOrder === draft.sort_order &&
    current.icon === draft.icon &&
    current.parentId === draft.parent_id
  );
}

/** 已知云基线的人工编辑采用严格晚于当前分类版本的服务端时间。 */
export function nextCategoryTimestamp(current: Category, now = new Date()): Date {
  return new Date(Math.max(now.getTime(), current.updatedAt.getTime() + 1));
}

/** 候选不可变，展示时读取当前同账号云对象；确认以独立云令牌再次比较。 */
export function mapCategoryConflict(candidate: CategoryConflict, current: Category) {
  return {
    id: candidate.id,
    category_id: candidate.categoryId,
    template_key: candidate.templateKey,
    source_device_id: candidate.sourceDeviceId,
    source_mutation_id: candidate.sourceMutationId,
    candidate_version: candidate.candidateVersion,
    action: candidate.action,
    local_payload: candidate.localPayload,
    local_updated_at: candidate.localUpdatedAt.toISOString(),
    cloud_snapshot: categoryState(current),
    status: candidate.status,
    resolution: candidate.resolution,
    created_at: candidate.createdAt.toISOString(),
    resolved_at: candidate.resolvedAt?.toISOString() ?? null,
  };
}

type Auth = { userId: string; deviceId: string };
type Intent = { mutation_id: string; entity_id: string; action: 'upsert' | 'delete'; payload: Record<string, unknown> };
type CategoryGuardResult =
  | { kind: 'apply'; updatedAt: Date }
  | { kind: 'accepted'; state: ReturnType<typeof categoryState>; resolution?: unknown }
  | { kind: 'conflict'; candidate: ReturnType<typeof mapCategoryConflict> };

/** 先处理来源回执，再比较已知基线；冲突必须提交候选后由调用方返回，不可抛错回滚候选。 */
export async function guardCategoryWrite(
  tx: SyncTransaction,
  auth: Auth,
  intent: Intent,
  current: Category | null,
  draft: CategoryDraft | null,
  requestHash: string,
  incomingAt: Date,
): Promise<CategoryGuardResult> {
  try {
    const { duplicate, deviceReservation: replay } = await checkMutationIdentity(
      tx,
      auth,
      intent.mutation_id,
      requestHash,
    );
    const previous = await tx.categoryConflict.findUnique({
      where: {
        ownerId_sourceDeviceId_sourceMutationId: {
          ownerId: auth.userId,
          sourceDeviceId: auth.deviceId,
          sourceMutationId: intent.mutation_id,
        },
      },
    });
    if (previous) {
      if (previous.requestHash !== requestHash || previous.categoryId !== intent.entity_id.toLowerCase())
        throw new ApiError(409, 'MUTATION_ID_REUSED', '该请求标识已经用于不同分类意图');
      if (!current) throw new ApiError(409, 'CATEGORY_VERSION_CHANGED', '云端分类身份已变化');
      if (previous.status === 'resolved')
        return { kind: 'accepted', state: categoryState(current), resolution: previous.resolutionResult };
      return { kind: 'conflict', candidate: mapCategoryConflict(previous, current) };
    }
    // 这是永久来源身份，不受普通 HTTP 缓存 generation/TTL 轮换影响。
    if (replay || duplicate) {
      if (!current) throw new ApiError(409, 'CATEGORY_VERSION_CHANGED', '云端分类身份已变化');
      return { kind: 'accepted', state: categoryState(current) };
    }
    const baseToken = intent.payload.base_token;
    if (baseToken !== undefined && (typeof baseToken !== 'string' || !/^[a-f0-9]{64}$/.test(baseToken)))
      throw new ApiError(400, 'INVALID_CATEGORY_BASE', '分类云端基线无效');
    const identity = officialCategoryIdentity(intent.entity_id);
    if (!identity) return { kind: 'apply', updatedAt: incomingAt };
    if (!current) {
      if (baseToken !== undefined) throw new ApiError(409, 'CATEGORY_VERSION_CHANGED', '分类云端身份已变化');
      return { kind: 'apply', updatedAt: incomingAt };
    }
    if (categoryIntentMatches(current, intent.action, draft)) {
      await reserveMutation(tx, auth, intent.mutation_id, requestHash);
      return { kind: 'accepted', state: categoryState(current) };
    }
    if (baseToken === categoryVersionToken(current) && current.deletedAt === null)
      return { kind: 'apply', updatedAt: nextCategoryTimestamp(current) };
    await reserveMutation(tx, auth, intent.mutation_id, requestHash);
    const created = await tx.categoryConflict.create({
      data: {
        ownerId: auth.userId,
        categoryId: current.id,
        templateKey: identity.key,
        sourceDeviceId: auth.deviceId,
        sourceMutationId: intent.mutation_id,
        requestHash,
        action: intent.action,
        localPayload: draft === null ? Prisma.JsonNull : draft,
        localUpdatedAt: incomingAt,
      },
    });
    return { kind: 'conflict', candidate: mapCategoryConflict(created, current) };
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw new Error('分类意图与来源身份校验失败', { cause });
  }
}

/** 官方分类 REST 写入要求稳定请求 UUID，并将请求身份规范为小写。 */
export function categoryRequestId(value: unknown): string {
  if (typeof value !== 'string' || !new RegExp(ANY_UUID_PATTERN).test(value))
    throw new ApiError(400, 'INVALID_IDEMPOTENCY_KEY', '分类请求需要 UUID 幂等键，请刷新后重试');
  return value.toLowerCase();
}
