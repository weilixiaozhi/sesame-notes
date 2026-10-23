import { categoryState } from '../../shared/category-version.js';
import type { Category, Ledger, LedgerMember, Prisma } from '@prisma/client';

import { decimalToCanonical } from '../../shared/decimal.js';
import { formatAaMode } from '../../shared/contracts/accounting.js';

export type LedgerRole = 'owner' | 'editor';

type TransactionWithSplits = Prisma.TransactionGetPayload<{ include: { splits: true } }>;

/** 返回账本权威所有者与当前调用者的成员权限，分类目录按所有者身份定位。 */
export function mapLedger(ledger: Ledger, role: LedgerRole, memberCount: number, member?: LedgerMember | null) {
  return {
    id: ledger.id,
    owner_id: ledger.ownerId,
    // 云同步时间线身份：客户端据此绑定/校验该账本的同步身份（LOCAL 账本无此字段）
    sync_id: ledger.syncId,
    name: ledger.name,
    currency: ledger.currency,
    month_start_day: ledger.monthStartDay,
    aa_enabled: ledger.aaEnabled,
    ...ledgerArchiveFields(member),
    role,
    member_count: memberCount,
    updated_at: ledger.updatedAt.toISOString(),
  };
}

/** 仅将当前账号成员的个人归档状态映射到已认证账本响应。 */
export function ledgerArchiveFields(
  member?: Pick<LedgerMember, 'archivedAt' | 'archiveUpdatedAt' | 'archiveUpdatedByDeviceId'> | null,
) {
  return {
    archived_at: member?.archivedAt?.toISOString() ?? null,
    archive_updated_at: member?.archiveUpdatedAt?.toISOString() ?? null,
    archive_device_id: member?.archiveUpdatedByDeviceId ?? null,
  };
}

/** 构造账本同步载荷，只包含跨端业务字段；sync_id 让 pull 方同步更新本地绑定。 */
export function ledgerPayload(ledger: Ledger): Prisma.InputJsonObject {
  return {
    id: ledger.id,
    owner_id: ledger.ownerId,
    sync_id: ledger.syncId,
    name: ledger.name,
    currency: ledger.currency,
    month_start_day: ledger.monthStartDay,
    aa_enabled: ledger.aaEnabled,
  };
}

export function mapCategory(category: Category) {
  return categoryState(category);
}

export function categoryPayload(category: Category): Prisma.InputJsonValue {
  return mapCategory(category) as Prisma.InputJsonValue;
}

/**
 * 映射交易响应，所有 Decimal 始终序列化为规范字符串。
 *
 * 成员引用单轨输出（created_by_member_id / last_edited_by_member_id / payer_member_id / splits[].member_id）。
 */
export function mapTransaction(transaction: TransactionWithSplits) {
  return {
    id: transaction.id,
    ledger_id: transaction.ledgerId,
    tx_type: transaction.txType,
    amount: decimalToCanonical(transaction.amount),
    happened_at: transaction.happenedAt.toISOString(),
    note: transaction.note,
    category_id: transaction.categoryId,
    category_name: transaction.categoryName,
    category_kind: transaction.categoryKind,
    currency_code: transaction.currencyCode,
    native_amount: decimalToCanonical(transaction.nativeAmount),
    recurring_id: transaction.recurringId,
    occurrence_date: transaction.occurrenceDate ?? null,
    created_by_member_id: transaction.createdByMemberId,
    last_edited_by_member_id: transaction.lastEditedByMemberId,
    payer_member_id: transaction.payerMemberId,
    // wire 契约：aa_mode 恒为字符串枚举，DB 整数经 formatAaMode 转换
    aa_mode: formatAaMode(transaction.aaMode),
    splits: [...transaction.splits]
      .sort((left, right) => left.memberId.localeCompare(right.memberId))
      .map((split) => ({
        member_id: split.memberId,
        amount: decimalToCanonical(split.amount),
      })),
    revision: transaction.revision,
    last_edited_at: transaction.lastEditedAt?.toISOString() ?? null,
    updated_at: transaction.updatedAt.toISOString(),
    created_at: transaction.createdAt.toISOString(),
  };
}

export function transactionPayload(transaction: TransactionWithSplits): Prisma.InputJsonValue {
  return mapTransaction(transaction) as Prisma.InputJsonValue;
}

/** 序列化周期规则与服务端生成游标，日历时区独立于编辑时间。 */
export function mapRecurring(row: {
  id: string;
  ledgerId: string;
  txType: string;
  amount: Prisma.Decimal;
  currencyCode: string;
  categoryId: string | null;
  note: string | null;
  frequency: string;
  interval: number;
  dayOfMonth: number | null;
  dayOfWeek: number | null;
  monthOfYear: number | null;
  startDate: Date;
  endDate: Date | null;
  lastGeneratedDate: Date | null;
  enabled: boolean;
  updatedAt: Date;
  protocolVersion: number;
  timeZone: string;
}) {
  return {
    protocol_version: row.protocolVersion,
    time_zone: row.timeZone,
    id: row.id,
    ledger_id: row.ledgerId,
    tx_type: row.txType,
    amount: decimalToCanonical(row.amount, 10),
    currency_code: row.currencyCode,
    category_id: row.categoryId,
    note: row.note,
    frequency: row.frequency,
    interval: row.interval,
    day_of_month: row.dayOfMonth,
    day_of_week: row.dayOfWeek,
    month_of_year: row.monthOfYear,
    start_date: row.startDate.toISOString(),
    end_date: row.endDate?.toISOString() ?? null,
    last_generated_date: row.lastGeneratedDate?.toISOString() ?? null,
    enabled: row.enabled,
    updated_at: row.updatedAt.toISOString(),
  };
}
