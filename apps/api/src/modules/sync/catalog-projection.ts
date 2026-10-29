import type { SyncTransaction } from '../../shared/sync-transaction.js';
import type { Prisma } from '@prisma/client';
import { ApiError } from '../../shared/errors.js';
import { RATE_PATTERN } from '../../shared/contracts/scalars.js';
import {
  guardCategoryWrite,
  normalizeCategoryDraft,
  updateCategoryTransactionSnapshots,
  exchangeRateOverrideId,
  getLedgerWriteAccess,
  validateParentCategory,
  assertCategoryCanDelete,
  importRecurringInitialState,
  validateRecurringTimeZone,
  recurringDate,
  nextRecurringDate,
} from '../accounting/index.js';
import { createChange } from '../sync-events/index.js';
import type { PushChange } from './sync-schemas.js';
import { categorySnapshot, recurringSnapshot, rateSnapshot } from './sync-snapshots.js';
import {
  type ApplyOutcome,
  isNewer,
  requireLedgerId,
  optionalString,
  requiredCurrency,
  requiredDecimal,
  requiredInteger,
  optionalInteger,
  requiredBoolean,
  requiredEnum,
  optionalAnyUuid,
  requiredDate,
  optionalDate,
} from './projection-support.js';

/** 分类先验证来源与云基线；只有自定义分类继续原 LWW，官方身份不能被无基线种子覆盖。 */
export async function applyCategory(
  tx: SyncTransaction,
  auth: { userId: string; deviceId: string },
  change: PushChange,
  updatedAt: Date,
  requestHash: string,
): Promise<ApplyOutcome> {
  if (change.ledger_id !== null)
    throw new ApiError(400, 'INVALID_CATEGORY_SCOPE', '分类是用户级实体，ledger_id 必须为 null');
  const current = await tx.category.findFirst({ where: { id: change.entity_id, ownerId: auth.userId } });
  const draft = change.action === 'upsert' ? normalizeCategoryDraft(change.payload, change.entity_id) : null;
  const guard = await guardCategoryWrite(tx, auth, change, current, draft, requestHash, updatedAt);
  if (guard.kind === 'accepted')
    return {
      status: 'applied',
      noChange: true,
      current_entity: guard.state,
      category_state: guard.state,
      category_resolution: guard.resolution,
    };
  if (guard.kind === 'conflict')
    return {
      status: 'conflict',
      current_entity: guard.candidate.cloud_snapshot,
      current_deleted: guard.candidate.cloud_snapshot.deleted_at !== null,
      category_conflict: guard.candidate,
    };
  updatedAt = guard.updatedAt;
  if (current && !isNewer(updatedAt, auth.deviceId, current.updatedAt, current.updatedByDeviceId)) {
    // 较旧命令未产生事件，回执仍携带权威内容及墓碑，供客户端确认原分类身份。
    const state = categorySnapshot(current);
    return {
      status: 'ignored',
      current_entity: state,
      current_deleted: current.deletedAt !== null,
      category_state: state,
    };
  }
  if (change.action === 'delete') {
    if (!current) return { status: 'ignored' };
    await assertCategoryCanDelete(tx, auth.userId, current.id);
    await updateCategoryTransactionSnapshots(tx, auth, { ...current, name: null, kind: null }, updatedAt);
    const deleted = await tx.category.update({
      where: { id_ownerId: { id: current.id, ownerId: auth.userId } },
      data: { deletedAt: updatedAt, updatedAt, updatedByDeviceId: auth.deviceId },
    });
    return {
      status: 'applied',
      payload: categorySnapshot(deleted),
      category_state: categorySnapshot(deleted),
      updatedAt,
    };
  }
  if (!draft) throw new ApiError(400, 'INVALID_CATEGORY_PAYLOAD', '分类内容无效');
  await validateParentCategory(tx, auth.userId, draft.parent_id, draft.level, change.entity_id);
  const data = {
    name: draft.name,
    kind: draft.kind,
    level: draft.level,
    sortOrder: draft.sort_order,
    icon: draft.icon,
    parentId: draft.parent_id,
    updatedAt,
    updatedByDeviceId: auth.deviceId,
  };
  const category = await tx.category.upsert({
    where: { id_ownerId: { id: change.entity_id, ownerId: auth.userId } },
    create: { id: change.entity_id, ownerId: auth.userId, ...data },
    update: { ...data, deletedAt: null },
  });
  await updateCategoryTransactionSnapshots(tx, auth, category, updatedAt);
  return {
    status: 'applied',
    payload: categorySnapshot(category),
    category_state: categorySnapshot(category),
    updatedAt,
  };
}

/** 应用周期账单模板，规则字段全部在服务端边界校验。 */
export async function applyRecurring(
  tx: SyncTransaction,
  auth: { userId: string; deviceId: string },
  change: PushChange,
  updatedAt: Date,
  requestHash: string,
): Promise<ApplyOutcome> {
  const ledgerId = requireLedgerId(change);
  const access = await getLedgerWriteAccess(tx, auth.userId, ledgerId, 'editor');
  const current = await tx.recurringTransaction.findUnique({ where: { id: change.entity_id } });
  if (current && current.ledgerId !== ledgerId)
    throw new ApiError(409, 'ENTITY_SCOPE_CONFLICT', '周期账单 UUID 已属于其他账本');
  if (change.payload.initial_state !== undefined && (current || access.role !== 'owner' || change.action !== 'upsert'))
    throw new ApiError(400, 'RECURRING_INITIAL_INVALID', '只有账本所有者可为全新规则原子迁入历史');
  if (current?.deletedAt)
    return { status: 'ignored', current_deleted: true, current_entity: recurringSnapshot(current) };
  if (current && !isNewer(updatedAt, auth.deviceId, current.updatedAt, current.updatedByDeviceId))
    return { status: 'ignored', current_entity: recurringSnapshot(current) };
  if (change.action === 'delete') {
    if (!current) return { status: 'ignored' };
    await tx.recurringTransaction.update({
      where: { id: current.id },
      data: { deletedAt: updatedAt, updatedAt, updatedByDeviceId: auth.deviceId },
    });
    return { status: 'applied' };
  }
  const payload = change.payload;
  if (payload.protocol_version !== 1) throw new ApiError(400, 'INVALID_RECURRING_PROTOCOL', '周期协议版本无效');
  const timeZone = validateRecurringTimeZone(payload.time_zone);
  if (current && current.timeZone !== timeZone) {
    // 发生日已用于确定性身份后不能重解释时区；墓碑也是已经发生的历史事实。
    const hasOccurrence =
      current.lastGeneratedDate !== null ||
      (await tx.transaction.findFirst({ where: { recurringId: current.id, ledgerId }, select: { id: true } })) !== null;
    if (hasOccurrence)
      throw new ApiError(409, 'RECURRING_TIME_ZONE_IMMUTABLE', '已生成账单的规则不能修改时区，请新建规则');
  }
  const categoryId = optionalAnyUuid(payload, 'category_id');
  const category = categoryId
    ? await tx.category.findFirst({ where: { id: categoryId, ownerId: access.ledger.ownerId, deletedAt: null } })
    : null;
  if (categoryId && !category) throw new ApiError(400, 'INVALID_CATEGORY', '周期账单分类不存在或不属于账本 Owner');
  const data = {
    txType: requiredEnum(payload, 'tx_type', ['expense']),
    amount: requiredDecimal(payload, 'amount'),
    currencyCode: requiredCurrency(payload, 'currency_code'),
    categoryId,
    note: optionalString(payload, 'note'),
    frequency: requiredEnum(payload, 'frequency', ['daily', 'weekly', 'monthly', 'yearly']),
    interval: requiredInteger(payload, 'interval', 1, 10000),
    dayOfMonth: optionalInteger(payload, 'day_of_month', 1, 31),
    dayOfWeek: optionalInteger(payload, 'day_of_week', 1, 7),
    monthOfYear: optionalInteger(payload, 'month_of_year', 1, 12),
    startDate: requiredDate(payload, 'start_date'),
    endDate: optionalDate(payload, 'end_date'),
    // 元数据编辑保留服务端已确认的进度；发生生成和原子历史迁入负责推进游标。
    lastGeneratedDate: current?.lastGeneratedDate ?? null,
    protocolVersion: 1,
    timeZone,
    enabled: requiredBoolean(payload, 'enabled'),
    deletedAt: null,
    updatedAt,
    updatedByDeviceId: auth.deviceId,
  };
  if (data.endDate !== null && data.endDate < data.startDate) {
    throw new ApiError(400, 'INVALID_RECURRING_DATE_RANGE', '周期账单结束日期不能早于开始日期');
  }
  nextRecurringDate(
    { ...data, enabled: true, startDate: recurringDate(data.startDate) },
    new Date('9999-12-31T00:00:00.000Z'),
  );
  const recurring = await tx.recurringTransaction.upsert({
    where: { id: change.entity_id },
    create: { id: change.entity_id, ledgerId, ownerId: access.ledger.ownerId, ...data },
    update: data,
  });
  if (payload.initial_state !== undefined) {
    const state = await importRecurringInitialState(
      tx,
      auth,
      recurring,
      access.ledger.currency,
      payload.initial_state,
      updatedAt,
    );
    const imported = await tx.recurringTransaction.update({
      where: { id: recurring.id },
      data: { ...state, updatedAt },
    });
    // 新设备先获得规则内容，再应用原始删除事件，才能完整保存已删除规则的历史身份。
    await createChange(
      tx,
      auth,
      ledgerId,
      'recurring_transaction',
      recurring.id,
      'upsert',
      recurringSnapshot(imported),
      updatedAt,
      null,
      state.deletedAt ? undefined : change.mutation_id,
      state.deletedAt ? null : requestHash,
    );
    if (state.deletedAt) {
      const changeId = await createChange(
        tx,
        auth,
        ledgerId,
        'recurring_transaction',
        recurring.id,
        'delete',
        { ...recurringSnapshot(imported), deleted_at: state.deletedAt.toISOString() },
        state.deletedAt,
        null,
        change.mutation_id,
        requestHash,
      );
      return { status: 'applied', changeId };
    }
    // 最后一条规则事件已保存客户端 mutation，调用方不得重复写相同回执。
    const receipt = await tx.syncChange.findFirstOrThrow({
      where: { deviceId: auth.deviceId, mutationId: change.mutation_id },
      select: { changeId: true },
    });
    return { status: 'applied', changeId: receipt.changeId };
  }
  return { status: 'applied', payload: recurringSnapshot(recurring) };
}

/** 应用用户级手动汇率覆盖，方向固定为一单位 base 对 rate 单位 quote。 */
export async function applyRateOverride(
  tx: Prisma.TransactionClient,
  auth: { userId: string; deviceId: string },
  change: PushChange,
  updatedAt: Date,
): Promise<ApplyOutcome> {
  if (change.ledger_id !== null)
    throw new ApiError(400, 'INVALID_RATE_SCOPE', '汇率覆盖是用户级实体，ledger_id 必须为 null');
  // 汇率覆盖使用确定性 UUIDv5：先校验 payload 币种，再核对 entity_id
  const baseCurrency = requiredCurrency(change.payload, 'base_currency');
  const quoteCurrency = requiredCurrency(change.payload, 'quote_currency');
  if (baseCurrency === quoteCurrency)
    throw new ApiError(400, 'INVALID_RATE_PAIR', '汇率覆盖的原币种与目标币种必须不同');
  const expectedId = exchangeRateOverrideId(auth.userId, baseCurrency, quoteCurrency);
  if (change.entity_id !== expectedId) {
    throw new ApiError(400, 'INVALID_RATE_ID', '汇率覆盖的 entity_id 必须是确定性 UUID（owner+base+quote 派生）');
  }
  const current = await tx.exchangeRateOverride.findUnique({ where: { id: expectedId } });
  if (current && current.ownerId !== auth.userId)
    throw new ApiError(409, 'ENTITY_SCOPE_CONFLICT', '汇率 UUID 已属于其他用户');
  if (current && !isNewer(updatedAt, auth.deviceId, current.updatedAt, current.updatedByDeviceId))
    return { status: 'ignored' };
  if (change.action === 'delete') {
    if (!current) return { status: 'ignored' };
    await tx.exchangeRateOverride.update({
      where: { id: current.id },
      data: { deletedAt: updatedAt, updatedAt, updatedByDeviceId: auth.deviceId },
    });
    return { status: 'applied' };
  }
  const data = {
    baseCurrency,
    quoteCurrency,
    rate: requiredDecimal(change.payload, 'rate', RATE_PATTERN),
    deletedAt: null,
    updatedAt,
    updatedByDeviceId: auth.deviceId,
  };
  const override = await tx.exchangeRateOverride.upsert({
    where: { id: expectedId },
    create: { id: change.entity_id, ownerId: auth.userId, ...data },
    update: data,
  });
  return { status: 'applied', payload: rateSnapshot(override) };
}
