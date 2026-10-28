import type { SyncTransaction } from '../../shared/sync-transaction.js';
import type { Prisma } from '@prisma/client';
import { ApiError } from '../../shared/errors.js';
import { parseAaMode } from '../../shared/contracts/accounting.js';
import {
  createdByMemberIdFor,
  resolvePayerMember,
  resolveSplitMembers,
  deleteTransactionMutation,
  updateTransactionMutation,
  createTransactionMutation,
  validateAaFields,
  type AaSplitInput,
  type TransactionMutationResult,
  getLedgerWriteAccess,
  mapTransaction,
  parseOccurrenceDate,
  recurringOccurrenceId,
  recurringToday,
  nextRecurringDate,
} from '../accounting/index.js';
import type { PushChange } from './sync-schemas.js';
import {
  type ApplyOutcome,
  requireLedgerId,
  optionalString,
  requiredCurrency,
  requiredDecimal,
  requiredEnum,
  optionalAnyUuid,
  requiredDate,
  optionalDate,
} from './projection-support.js';

/** 构造 revision 冲突结果：携带当前版本、删除标记与完整实体快照供 UI 决策。 */
function conflictOutcome(current: Prisma.TransactionGetPayload<{ include: { splits: true } }> | null): ApplyOutcome {
  if (!current) {
    return { status: 'conflict', current_revision: 0, current_deleted: false, current_entity: null };
  }
  // tombstone 不产出实体快照（current_entity=null，UI 以 current_deleted 渲染云端已删除）
  if (current.deletedAt !== null) {
    return {
      status: 'conflict',
      current_revision: current.revision,
      current_deleted: true,
      current_entity: null,
    };
  }
  // 领域层已在当前同步事务中读取完整快照，版本与内容必须来自同一份结果。
  return {
    status: 'conflict',
    current_revision: current.revision,
    current_deleted: false,
    current_entity: mapTransaction(current),
  };
}

/**
 * 应用账本级交易变更（revision 状态机）。
 *
 * 状态机：
 * - CREATE：期望实体不存在 → revision 1（base 声明已存在 → CONFLICT）；
 * - UPDATE：base N 与当前 revision 一致 → CAS 更新为 N+1，否则 CONFLICT；
 * - DELETE：base N → tombstone revision N+1；对不存在/已删除实体 = no-op；
 * - 对 tombstone 的 UPDATE 一律 CONFLICT（current_deleted=true），绝不复活。
 */
export async function applyTransaction(
  tx: SyncTransaction,
  auth: { userId: string; deviceId: string },
  change: PushChange,
  updatedAt: Date,
  requestHash: string,
): Promise<ApplyOutcome> {
  const ledgerId = requireLedgerId(change).toLowerCase();
  const access = await getLedgerWriteAccess(tx, auth.userId, ledgerId, 'editor');
  const base = change.base_revision;
  const current = await tx.transaction.findUnique({ where: { id: change.entity_id }, include: { splits: true } });
  if (current && current.ledgerId !== ledgerId)
    throw new ApiError(409, 'ENTITY_SCOPE_CONFLICT', '交易 UUID 已属于其他账本');

  const initialHistory = change.payload.initial_history;
  if (
    initialHistory !== undefined &&
    (initialHistory !== true ||
      access.role !== 'owner' ||
      current ||
      change.action !== 'upsert' ||
      (base !== undefined && base !== 0) ||
      change.payload.recurring_id != null)
  )
    throw new ApiError(400, 'INVALID_TRANSACTION_INITIAL_HISTORY', '只有账本所有者可为全新普通交易明确导入历史参与人');

  if (change.action === 'delete') {
    const result = await deleteTransactionMutation(tx, auth, {
      ledgerId,
      transactionId: change.entity_id,
      baseRevision: base,
      updatedAt,
      mutationId: change.mutation_id,
      requestHash,
    });
    return mapPushTransactionMutation(result, true);
  }

  // ---- upsert：先做与 REST 一致的载荷校验，再走 create/update 状态机 ----
  const payload = change.payload;
  const recurringId = optionalAnyUuid(payload, 'recurring_id')?.toLowerCase() ?? null;
  const occurrenceDate =
    payload.occurrence_date == null
      ? (current?.occurrenceDate ?? null)
      : parseOccurrenceDate(payload.occurrence_date).toISOString().slice(0, 10);
  if (
    current &&
    (current.recurringId || recurringId || current.occurrenceDate || occurrenceDate) &&
    (recurringId !== current.recurringId || occurrenceDate !== current.occurrenceDate)
  )
    throw new ApiError(400, 'RECURRING_ORIGIN_IMMUTABLE', '已有周期发生的规则和日期不能修改');
  if (
    occurrenceDate &&
    (!recurringId || recurringOccurrenceId(ledgerId, recurringId, occurrenceDate) !== change.entity_id.toLowerCase())
  )
    throw new ApiError(400, 'INVALID_RECURRING_OCCURRENCE', '周期发生身份与来源不一致');
  if (current && occurrenceDate && (base === undefined || base === 0)) {
    // 两端离线生成同一天或服务端先生成时，以当前云端记录确认；不能覆盖后继人工编辑或复活墓碑。
    return {
      status: 'ignored',
      current_revision: current.revision,
      current_deleted: current.deletedAt !== null,
      current_entity: current.deletedAt ? null : mapTransaction(current),
    };
  }
  const categoryId = optionalAnyUuid(payload, 'category_id');
  const category = categoryId
    ? await tx.category.findFirst({ where: { id: categoryId, ownerId: access.ledger.ownerId, deletedAt: null } })
    : null;
  if (categoryId && !category) throw new ApiError(400, 'INVALID_CATEGORY', '交易分类不存在或不属于账本 Owner');
  const recurring = recurringId
    ? await tx.recurringTransaction.findFirst({
        where: { id: recurringId, ledgerId, ...(current?.recurringId === recurringId ? {} : { deletedAt: null }) },
      })
    : null;
  if (recurringId && !recurring) throw new ApiError(400, 'INVALID_RECURRING', '交易周期账单不存在或不属于当前账本');
  if (!current && recurringId && !occurrenceDate)
    throw new ApiError(400, 'INVALID_RECURRING_OCCURRENCE', '新周期账单必须携带可验证的发生日期');
  if (!current && occurrenceDate && recurring) {
    const date = parseOccurrenceDate(occurrenceDate);
    const expected = nextRecurringDate(
      { ...recurring, lastGeneratedDate: new Date(date.getTime() - 86_400_000) },
      recurringToday(recurring.timeZone, new Date()),
    );
    if (!expected || expected.getTime() !== date.getTime())
      throw new ApiError(400, 'INVALID_RECURRING_OCCURRENCE', '周期发生未到期或不符合当前规则');
  }
  const amount = requiredDecimal(payload, 'amount');
  const currencyCode = requiredCurrency(payload, 'currency_code');
  const nativeAmount = requiredDecimal(payload, 'native_amount');
  if (currencyCode === access.ledger.currency && amount !== nativeAmount)
    throw new ApiError(400, 'INVALID_NATIVE_AMOUNT', '本位币交易折算金额必须等于原始金额');
  // wire 契约：aa_mode 为字符串枚举（'0'/'1'/'2'），落库前统一转整数
  let aaMode: ReturnType<typeof parseAaMode>;
  const aaSplits = (payload.splits as AaSplitInput[] | null | undefined) ?? null;
  try {
    // 原始模式与分摊共同属于单条输入校验；非法类型必须返回 invalid，不能中断后续变更。
    aaMode = parseAaMode(payload.aa_mode);
    validateAaFields(nativeAmount, aaMode, aaSplits);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'INVALID_AA_SPLITS';
    throw new ApiError(
      400,
      code,
      code === 'INVALID_AA_MODE' ? 'AA 分摊模式无效' : 'AA 指定分摊金额与交易折算金额不一致',
    );
  }
  // payer 输入解析为账本级 memberId（同账本 FK 约束）；缺省 = 记账人（认证推导）。
  // REGISTERED member_id 为 UUIDv5 派生，不能用 v4 专用校验
  const payerId = optionalAnyUuid(payload, 'payer_member_id');
  // 历史导入不改变成员生命周期；普通编辑只能保留该交易原先对应角色的成员集合。
  const historicalPayers = new Set(
    initialHistory === true
      ? payerId
        ? [payerId.toLowerCase()]
        : []
      : current?.payerMemberId
        ? [current.payerMemberId]
        : [],
  );
  const historicalSplits = new Set(
    initialHistory === true
      ? (aaSplits ?? []).flatMap((split) => (split.member_id ? [split.member_id.toLowerCase()] : []))
      : (current?.splits ?? []).map((split) => split.memberId),
  );
  const payerMember = await resolvePayerMember(tx, ledgerId, auth.userId, payerId, historicalPayers);
  const splitMembers = await resolveSplitMembers(tx, ledgerId, aaSplits, historicalSplits);
  const fields = {
    txType: requiredEnum(payload, 'tx_type', ['expense']),
    amount,
    happenedAt: requiredDate(payload, 'happened_at'),
    note: optionalString(payload, 'note'),
    categoryId,
    categoryName: category?.name ?? null,
    categoryKind: category?.kind ?? null,
    currencyCode,
    nativeAmount,
    recurringId,
    occurrenceDate,
    payerMemberId: payerMember,
    aaMode,
  };

  if (!current) {
    // CREATE：期望实体不存在 → revision 1；客户端声明 base>0（认为已存在）→ CONFLICT
    if (base !== undefined && base > 0) return conflictOutcome(null);
    // 同步提交锁保证读取与创建串行；存储失败由事务回滚并交给请求错误边界处理。
    const result = await createTransactionMutation(tx, auth, {
      data: {
        id: change.entity_id,
        ledgerId,
        ownerId: access.ledger.ownerId,
        ...fields,
        // createdBy/lastEditedBy 由认证推导（不信任 payload）
        createdByMemberId: createdByMemberIdFor(ledgerId, auth.userId),
        lastEditedByMemberId: createdByMemberIdFor(ledgerId, auth.userId),
        revision: 1,
        lastEditedAt: optionalDate(payload, 'last_edited_at'),
        updatedAt,
        updatedByDeviceId: auth.deviceId,
      },
      splits: splitMembers,
      mutationId: change.mutation_id,
      requestHash,
      recurringCursor: occurrenceDate && recurring ? recurring : undefined,
    });
    return { status: 'applied', revision: result.revision, changeId: result.changeId };
  }

  const result = await updateTransactionMutation(tx, auth, {
    ledgerId,
    transactionId: change.entity_id,
    baseRevision: base,
    fields,
    splits: splitMembers,
    historyChanges: {
      ...payload,
      ...(base === undefined ? {} : { base_revision: base }),
    } as Prisma.InputJsonValue,
    updatedAt,
    mutationId: change.mutation_id,
    requestHash,
  });
  return mapPushTransactionMutation(result, false);
}

/** 把共享 mutation core 的结果映射为 push 的 per-mutation 状态。 */
function mapPushTransactionMutation(result: TransactionMutationResult, ignoreAbsentDelete: boolean): ApplyOutcome {
  if (result.status === 'applied') {
    return { status: 'applied', revision: result.revision, changeId: result.changeId };
  }
  if (result.status === 'scope_conflict') {
    throw new ApiError(409, 'ENTITY_SCOPE_CONFLICT', '交易 UUID 已属于其他账本');
  }
  if (ignoreAbsentDelete && (result.status === 'not_found' || result.status === 'deleted')) {
    return { status: 'ignored' };
  }
  return conflictOutcome(result.current);
}
