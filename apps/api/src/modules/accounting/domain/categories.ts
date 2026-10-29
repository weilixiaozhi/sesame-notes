import { normalizeName } from '../../../shared/text-validation.js';
import { NameSchema, AnyUuidSchema, ANY_UUID_PATTERN } from '../../../shared/contracts/scalars.js';
import { TransactionTypeSchema } from '../../../shared/contracts/accounting.js';
import type { Prisma, PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';

import { ApiError } from '../../../shared/errors.js';
import type { SyncTransaction } from '../../../shared/sync-transaction.js';

// 分类 id 兼容确定性 UUIDv5（seed 默认分类派生 id），父分类引用同口径
const NullableCategoryUuid = Type.Union([AnyUuidSchema, Type.Null()]);

/** 分类创建/导入的输入契约：REST 路由与 imports 模块共用同一份校验。 */
export const CategoryInput = Type.Object({
  id: Type.Optional(AnyUuidSchema),
  name: NameSchema,
  kind: TransactionTypeSchema,
  level: Type.Union([Type.Literal(1), Type.Literal(2)]),
  sort_order: Type.Optional(Type.Integer()),
  icon: Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()])),
  parent_id: Type.Optional(NullableCategoryUuid),
});

export type CategoryCreate = {
  id?: string;
  name: string;
  kind: string;
  level: 1 | 2;
  sort_order?: number;
  icon?: string | null;
  parent_id?: string | null;
};

/** 所属关系是分类结构的唯一来源；持久化与协议层级字段由关系派生。 */
export function categoryLevel(parentId: string | null | undefined): 1 | 2 {
  return parentId == null ? 1 : 2;
}

/** 分类存储字段共用数据库边界：排序为有符号 32 位整数，图标只接受可存储文本并按 Unicode 字符数计长。 */
export function validateCategoryFields(body: {
  sort_order?: unknown;
  icon?: unknown;
}): asserts body is { sort_order?: number; icon?: string | null } {
  try {
    if (
      body.sort_order !== undefined &&
      (typeof body.sort_order !== 'number' ||
        !Number.isInteger(body.sort_order) ||
        body.sort_order < -2_147_483_648 ||
        body.sort_order > 2_147_483_647)
    ) {
      throw new ApiError(400, 'INVALID_CATEGORY_SORT_ORDER', '分类排序值超出允许范围');
    }
    if (
      body.icon !== undefined &&
      body.icon !== null &&
      (typeof body.icon !== 'string' ||
        !body.icon.isWellFormed() ||
        body.icon.includes('\u0000') ||
        Array.from(body.icon).length > 255)
    ) {
      throw new ApiError(400, 'INVALID_CATEGORY_ICON', '分类图标格式无效或超过 255 个字符');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('分类存储字段校验失败', { cause: error });
  }
}

/** 校验父关系的身份、静态结构与当前可用性，分别报告可修正内容和动态依赖错误。 */
export async function validateParentCategory(
  prisma: PrismaClient | Prisma.TransactionClient,
  ownerId: string,
  parentId: string | null,
  level: number,
  selfId?: string,
): Promise<void> {
  try {
    if (parentId !== null && (typeof parentId !== 'string' || !new RegExp(ANY_UUID_PATTERN).test(parentId)))
      throw new ApiError(400, 'INVALID_CATEGORY_PARENT', '父分类身份无效');
    // 自引用本身已经构成环，先报告明确的关系错误，再检查层级和远端父节点。
    if (parentId && parentId === selfId) throw new ApiError(400, 'CATEGORY_CYCLE', '分类不能以自身为父分类');
    if (level !== 1 && level !== 2) throw new ApiError(400, 'INVALID_CATEGORY_LEVEL', '分类关系格式无效');
    if (level !== categoryLevel(parentId)) {
      throw new ApiError(
        400,
        parentId ? 'CATEGORY_PARENT_FORBIDDEN' : 'CATEGORY_PARENT_REQUIRED',
        '分类关系无效，请重新选择所属分类',
      );
    }
    if (!parentId) return;
    const parent = await prisma.category.findFirst({
      where: { id: parentId, ownerId, deletedAt: null, parentId: null },
    });
    if (!parent) throw new ApiError(400, 'CATEGORY_PARENT_UNAVAILABLE', '父分类不存在或不可用');
    if (selfId) {
      // 分类 ID 可在不同账号复用，只有当前所有者的有效子节点会形成第三级。
      const child = await prisma.category.findFirst({
        where: { parentId: selfId, ownerId, deletedAt: null },
        select: { id: true },
      });
      if (child) throw new ApiError(400, 'CATEGORY_HAS_CHILDREN', '分类包含子分类，不能再放入其他分类');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('分类父子关系校验失败', { cause: error });
  }
}

/** 同一事务内确认分类没有活子级或活交易，删除策略须先处理全部引用。 */
export async function assertCategoryCanDelete(tx: SyncTransaction, ownerId: string, categoryId: string): Promise<void> {
  try {
    const child = await tx.category.findFirst({
      where: { ownerId, parentId: categoryId, deletedAt: null },
      select: { id: true },
    });
    if (child) throw new ApiError(409, 'CATEGORY_HAS_CHILDREN', '请先处理子分类，不能留下引用已删除父分类的子分类');
    const transaction = await tx.transaction.findFirst({
      where: { ownerId, categoryId, deletedAt: null },
      select: { id: true },
    });
    if (transaction) throw new ApiError(409, 'CATEGORY_HAS_TRANSACTIONS', '请先选择迁移或删除关联交易，再删除分类');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('分类删除关系校验失败', { cause: error });
  }
}

/** 构造新分类数据，客户端提供 UUID 时保持原值。 */
export function categoryData(
  ownerId: string,
  deviceId: string,
  body: CategoryCreate,
  now: Date,
): Prisma.CategoryUncheckedCreateInput {
  validateCategoryFields(body);
  return {
    ...(body.id ? { id: body.id } : {}),
    ownerId,
    name: normalizeName(body.name),
    kind: body.kind,
    level: categoryLevel(body.parent_id),
    sortOrder: body.sort_order ?? 0,
    icon: body.icon ?? null,
    parentId: body.parent_id ?? null,
    updatedAt: now,
    updatedByDeviceId: deviceId,
  };
}
