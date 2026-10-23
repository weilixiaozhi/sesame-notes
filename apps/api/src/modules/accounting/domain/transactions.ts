import type { Prisma, Category, PrismaClient, RecurringTransaction } from '@prisma/client';
import { Type } from '@sinclair/typebox';

import { ApiError } from '../../../shared/errors.js';
import { AaModeSchema, parseAaMode, TransactionTypeSchema } from '../../../shared/contracts/accounting.js';
import {
  AnyUuidSchema,
  CurrencySchema,
  PositiveAmountSchema,
  TimestampSchema,
} from '../../../shared/contracts/scalars.js';

import { createdByMemberIdFor } from '../member-refs.js';
import { validateAaFields, type AaSplitInput } from '../money.js';

// 实体引用统一为「合法 UUID 或 null」：分类、成员、周期模板的 id 都可能是确定性 v5
const NullableEntityId = Type.Union([AnyUuidSchema, Type.Null()]);
const BaseRevisionSchema = Type.Integer({ minimum: 0 });
const SplitInput = Type.Object({
  // 参与人成员引用（UUID v4/v5 兼容）
  member_id: AnyUuidSchema,
  amount: PositiveAmountSchema,
});

/** 交易创建/导入的输入契约：REST 路由与 imports 模块共用同一份校验。 */
export const TransactionInput = Type.Object({
  id: Type.Optional(AnyUuidSchema),
  tx_type: TransactionTypeSchema,
  amount: PositiveAmountSchema,
  happened_at: TimestampSchema,
  note: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  category_id: Type.Optional(NullableEntityId),
  currency_code: CurrencySchema,
  native_amount: PositiveAmountSchema,
  recurring_id: Type.Optional(NullableEntityId),
  occurrence_date: Type.Optional(Type.Union([Type.String({ format: 'date' }), Type.Null()])),
  // payer 成员引用（UUIDv5 派生 REGISTERED 或 PLACEHOLDER，v5 兼容）
  payer_member_id: Type.Optional(NullableEntityId),
  aa_mode: Type.Optional(AaModeSchema),
  splits: Type.Optional(Type.Union([Type.Array(SplitInput, { maxItems: 100 }), Type.Null()])),
  // 乐观并发基线仅供 PATCH 使用，创建与导入会忽略该可选字段。
  base_revision: Type.Optional(BaseRevisionSchema),
});

export type TransactionCreate = {
  id?: string;
  tx_type: string;
  amount: string;
  happened_at: string;
  note?: string | null;
  category_id?: string | null;
  currency_code: string;
  native_amount: string;
  recurring_id?: string | null;
  occurrence_date?: string | null;
  payer_member_id?: string | null;
  aa_mode?: '0' | '1' | '2' | null;
  splits?: AaSplitInput[] | null;
  base_revision?: number;
};

/** 解析交易分类并确认它属于账本 Owner，避免共享账本引用成员私有分类。 */
export async function resolveCategory(
  prisma: PrismaClient | Prisma.TransactionClient,
  ownerId: string,
  categoryId: string | null,
): Promise<Category | null> {
  try {
    if (!categoryId) return null;
    const category = await prisma.category.findFirst({ where: { id: categoryId, ownerId, deletedAt: null } });
    if (!category) throw new ApiError(400, 'INVALID_CATEGORY', '所选分类不存在或不属于该账本');
    return category;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('交易分类校验失败', { cause: error });
  }
}

/** 解析当前账本周期模板；原交易保留相同来源时允许编辑已删除规则的历史发生。 */
export async function resolveRecurring(
  prisma: PrismaClient | Prisma.TransactionClient,
  ledgerId: string,
  recurringId: string | null,
  retainedRecurringId: string | null = null,
): Promise<RecurringTransaction | null> {
  try {
    if (!recurringId) return null;
    const recurring = await prisma.recurringTransaction.findFirst({
      where: { id: recurringId, ledgerId, ...(recurringId === retainedRecurringId ? {} : { deletedAt: null }) },
    });
    if (!recurring) throw new ApiError(400, 'INVALID_RECURRING', '周期账单不存在或不属于当前账本');
    return recurring;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('交易周期账单校验失败', { cause: error });
  }
}

/** 已确认周期发生的来源身份保持不变，存量规则引用继续经过账本归属校验。 */
export function validateTransactionSource(
  current: { recurringId: string | null; occurrenceDate: string | null },
  patch: Pick<TransactionCreate, 'recurring_id' | 'occurrence_date'>,
): void {
  if (
    current.recurringId === null &&
    current.occurrenceDate === null &&
    patch.recurring_id == null &&
    patch.occurrence_date == null
  )
    return;
  if (
    (patch.recurring_id !== undefined && (patch.recurring_id?.toLowerCase() ?? null) !== current.recurringId) ||
    (patch.occurrence_date !== undefined && patch.occurrence_date !== current.occurrenceDate)
  ) {
    throw new ApiError(409, 'RECURRING_SOURCE_IMMUTABLE', '交易的周期来源和发生日期不能修改，请保留原始来源');
  }
}

/** 校验完整交易的多币种与 AA 分摊不变量，本位币交易也要求显式保存币种与快照。 */
export function validateCurrencySnapshot(
  ledgerCurrency: string,
  body: Pick<TransactionCreate, 'amount' | 'currency_code' | 'native_amount' | 'aa_mode' | 'splits'>,
): void {
  if (body.currency_code === ledgerCurrency && body.amount !== body.native_amount) {
    throw new ApiError(400, 'INVALID_NATIVE_AMOUNT', '本位币交易的折算金额必须等于原始金额');
  }
  try {
    validateAaFields(body.native_amount, parseAaMode(body.aa_mode), body.splits);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'INVALID_AA_SPLITS';
    throw new ApiError(400, code, 'AA 指定分摊金额与交易折算金额不一致');
  }
}

/** 构造交易写入数据，并保存分类展示快照和协作作者。 */
export function transactionData(
  ledgerId: string,
  ownerId: string,
  auth: { userId: string; deviceId: string },
  body: TransactionCreate,
  category: Category | null,
  now: Date,
  payerMemberId: string,
): Prisma.TransactionUncheckedCreateInput {
  // 普通创建与通用导入只接收普通交易；周期发生由到期生成或原子历史迁入建立。
  if (body.recurring_id != null || body.occurrence_date != null) {
    throw new ApiError(400, 'RECURRING_GENERATION_REQUIRED', '周期发生请通过到期生成或完整周期历史迁入');
  }
  return {
    ...(body.id ? { id: body.id } : {}),
    ledgerId,
    ownerId,
    txType: body.tx_type,
    amount: body.amount,
    happenedAt: new Date(body.happened_at),
    note: body.note ?? null,
    categoryId: body.category_id ?? null,
    categoryName: category?.name ?? null,
    categoryKind: category?.kind ?? null,
    currencyCode: body.currency_code,
    nativeAmount: body.native_amount,
    recurringId: null,
    // 记账人/操作者由认证推导，payer 为解析后的账本级成员引用
    createdByMemberId: createdByMemberIdFor(ledgerId, auth.userId),
    lastEditedByMemberId: createdByMemberIdFor(ledgerId, auth.userId),
    payerMemberId,
    aaMode: parseAaMode(body.aa_mode),
    updatedAt: now,
    updatedByDeviceId: auth.deviceId,
  };
}
