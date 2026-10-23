import type { RecurringTransaction } from '@prisma/client';
import type { SyncTransaction } from '../../shared/sync-transaction.js';
import { parseAaMode } from '../../shared/contracts/accounting.js';
import { ANY_UUID_PATTERN, POSITIVE_AMOUNT_PATTERN, parseStrictTimestamp } from '../../shared/contracts/scalars.js';
import { ApiError } from '../../shared/errors.js';
import { createdByMemberIdFor } from './member-refs.js';
import { validateAaFields, type AaSplitInput } from './money.js';
import { createTransactionHistory } from './transaction-creation.js';
import { parseOccurrenceDate, recurringOccurrenceId, recurringToday } from './recurring-schedule.js';

/** 历史迁入失败统一映射为可操作的业务错误，事务边界保证规则和全部历史一并回滚。 */
function rejectInitial(detail: string): never {
  throw new ApiError(400, 'RECURRING_INITIAL_INVALID', `周期历史迁入失败：${detail}`);
}

/** 读取明确的空值或规范时间戳，不让 JavaScript 自动转换非法日期。 */
function nullableTimestamp(value: unknown): Date | null {
  if (value === null) return null;
  return parseStrictTimestamp(value, 'RECURRING_INITIAL_INVALID', '周期历史时间戳无效');
}

/** 原子迁入单条新规则的既有发生与墓碑；历史不按当前排期重算，原始删除时间和人工金额必须保留。 */
export async function importRecurringInitialState(
  tx: SyncTransaction,
  auth: { userId: string; deviceId: string },
  rule: RecurringTransaction,
  currency: string,
  input: unknown,
  updatedAt: Date,
): Promise<{ lastGeneratedDate: Date | null; deletedAt: Date | null }> {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) rejectInitial('历史状态格式无效');
    const state = input as Record<string, unknown>;
    if (!Array.isArray(state.occurrences) || state.occurrences.length > 10000)
      rejectInitial('发生数量超过原子迁入上限');
    const lastGeneratedDate = nullableTimestamp(state.last_generated_date);
    const deletedAt = nullableTimestamp(state.deleted_at);
    const now = new Date();
    // 整批历史共用同一规则时区与校验时刻，日历日只计算一次。
    const today = recurringToday(rule.timeZone, now);
    if ((deletedAt && deletedAt > now) || (lastGeneratedDate && lastGeneratedDate > today))
      rejectInitial('历史包含未来进度或删除时间');
    const [categories, members] = await Promise.all([
      tx.category.findMany({ where: { ownerId: rule.ownerId, deletedAt: null } }),
      tx.ledgerMember.findMany({ where: { ledgerId: rule.ledgerId } }),
    ]);
    const categoryMap = new Map(categories.map((row) => [row.id, row]));
    const memberIds = new Set(members.map((row) => row.id));
    const author = createdByMemberIdFor(rule.ledgerId, auth.userId);
    const ids = new Set<string>();
    const dates = new Set<string>();
    const creations: Parameters<typeof createTransactionHistory>[3] = [];
    for (const raw of state.occurrences) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) rejectInitial('发生格式无效');
      const occurrence = raw as { id?: unknown; deleted_at?: unknown; payload?: unknown };
      if (!occurrence.payload || typeof occurrence.payload !== 'object' || Array.isArray(occurrence.payload))
        rejectInitial('发生内容无效');
      const payload = occurrence.payload as Record<string, unknown>;
      const date = parseOccurrenceDate(payload.occurrence_date);
      const dateKey = date.toISOString().slice(0, 10);
      const id = recurringOccurrenceId(rule.ledgerId, rule.id, dateKey);
      if (
        typeof occurrence.id !== 'string' ||
        occurrence.id.toLowerCase() !== id ||
        ids.has(id) ||
        payload.recurring_id !== rule.id ||
        date > today
      )
        rejectInitial('发生身份、日期或来源无效');
      ids.add(id);
      dates.add(dateKey);
      const deleted = nullableTimestamp(occurrence.deleted_at);
      if (deleted && deleted > now) rejectInitial('发生删除时间在未来');
      const categoryId = payload.category_id == null ? null : String(payload.category_id).toLowerCase();
      const category = categoryId ? categoryMap.get(categoryId) : null;
      if (categoryId && !category) rejectInitial('历史分类已缺失或不属于账本');
      const payer = payload.payer_member_id == null ? author : String(payload.payer_member_id).toLowerCase();
      if (!memberIds.has(payer)) rejectInitial('付款成员不属于当前账本');
      let aaMode: ReturnType<typeof parseAaMode>;
      try {
        aaMode = parseAaMode(payload.aa_mode);
      } catch {
        rejectInitial('历史分摊模式无效');
      }
      const aaSplits = payload.splits == null ? [] : (payload.splits as AaSplitInput[]);
      if (!Array.isArray(aaSplits) || aaSplits.length > 100) rejectInitial('分摊列表无效');
      if (
        payload.tx_type !== 'expense' ||
        typeof payload.currency_code !== 'string' ||
        !/^[A-Z]{3}$/.test(payload.currency_code) ||
        typeof payload.amount !== 'string' ||
        !new RegExp(POSITIVE_AMOUNT_PATTERN).test(payload.amount) ||
        typeof payload.native_amount !== 'string' ||
        !new RegExp(POSITIVE_AMOUNT_PATTERN).test(payload.native_amount)
      )
        rejectInitial('历史金额或币种无效');
      if (payload.currency_code === currency && payload.amount !== payload.native_amount)
        rejectInitial('本币金额与原始金额不一致');
      try {
        validateAaFields(payload.native_amount, aaMode, aaSplits);
      } catch {
        rejectInitial('历史分摊金额或参与人无效');
      }
      if (payload.note !== null && typeof payload.note !== 'string') rejectInitial('历史备注无效');
      const splits: Array<{ memberId: string; amount: string }> = [];
      for (const split of aaSplits) {
        const memberId = split.member_id?.toLowerCase();
        if (!memberId || !new RegExp(ANY_UUID_PATTERN).test(memberId) || !memberIds.has(memberId))
          rejectInitial('历史分摊成员不属于当前账本');
        splits.push({ memberId, amount: split.amount });
      }
      creations.push({
        data: {
          id,
          ledgerId: rule.ledgerId,
          ownerId: rule.ownerId,
          txType: 'expense',
          amount: payload.amount,
          nativeAmount: payload.native_amount,
          currencyCode: payload.currency_code,
          happenedAt: parseStrictTimestamp(payload.happened_at, 'RECURRING_INITIAL_INVALID', '周期历史发生时间无效'),
          note: payload.note == null ? null : String(payload.note),
          categoryId,
          categoryName: category?.name ?? null,
          categoryKind: category?.kind ?? null,
          recurringId: rule.id,
          occurrenceDate: dateKey,
          payerMemberId: payer,
          createdByMemberId: author,
          lastEditedByMemberId: author,
          aaMode,
          lastEditedAt:
            payload.last_edited_at == null
              ? null
              : parseStrictTimestamp(payload.last_edited_at, 'RECURRING_INITIAL_INVALID', '周期历史编辑时间无效'),
          deletedAt: deleted,
          // 墓碑比首次物化高一个修订，客户端不能把删除当成同版本重放忽略。
          revision: deleted ? 2 : 1,
          updatedAt: deleted ?? updatedAt,
          updatedByDeviceId: auth.deviceId,
        },
        splits,
      });
    }
    if (lastGeneratedDate && !dates.has(lastGeneratedDate.toISOString().slice(0, 10)))
      rejectInitial('生成游标缺少对应发生或墓碑');
    // 先完成整批校验，再分片写入；任何一片失败由调用方事务回滚，不截断历史。
    await createTransactionHistory(tx, auth, rule.ledgerId, creations);
    return { lastGeneratedDate, deletedAt };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'RECURRING_INITIAL_INVALID') throw error;
    if (error instanceof ApiError)
      throw Object.assign(
        new ApiError(400, 'RECURRING_INITIAL_INVALID', '周期历史字段无效，请核对发生日期、金额及成员引用'),
        { cause: error },
      );
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
      throw Object.assign(
        new ApiError(409, 'RECURRING_INITIAL_CONFLICT', '周期历史身份已被其他记录使用，请刷新后重试'),
        { cause: error },
      );
    throw new Error('周期历史原子迁入异常', { cause: error });
  }
}
