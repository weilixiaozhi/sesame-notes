import type { RecurringTransaction } from '@prisma/client';
import type { SyncTransaction } from '../../shared/sync-transaction.js';
import { createChange } from '../sync-events/index.js';
import { mapRecurring } from './mappers.js';
import { nextRecurringDate, recurringOccurrenceId, recurringToday } from './recurring-schedule.js';

/** 只跨过数据库已经存在的连续发生或墓碑推进游标，离线请求不能跳过未生成日期。 */
export async function advanceRecurringCursor(
  tx: SyncTransaction,
  auth: { userId: string; deviceId: string },
  rule: RecurringTransaction,
): Promise<void> {
  try {
    const original = rule.lastGeneratedDate?.getTime();
    const today = recurringToday(rule.timeZone, new Date());
    let next = nextRecurringDate(rule, today);
    for (let count = 0; next && count < 10000; count++) {
      const date = next.toISOString().slice(0, 10);
      const occurrence = await tx.transaction.findUnique({
        where: { id: recurringOccurrenceId(rule.ledgerId, rule.id, date) },
        select: { recurringId: true, occurrenceDate: true },
      });
      if (!occurrence || occurrence.recurringId !== rule.id || occurrence.occurrenceDate !== date) break;
      rule.lastGeneratedDate = next;
      next = nextRecurringDate(rule, today);
    }
    if (rule.lastGeneratedDate?.getTime() !== original) {
      const stored = await tx.recurringTransaction.update({
        where: { id: rule.id },
        data: { lastGeneratedDate: rule.lastGeneratedDate, updatedAt: rule.updatedAt },
      });
      await createChange(
        tx,
        auth,
        rule.ledgerId,
        'recurring_transaction',
        rule.id,
        'upsert',
        mapRecurring(stored),
        stored.updatedAt,
      );
    }
  } catch (cause) {
    throw new Error('周期账单连续生成进度更新失败', { cause });
  }
}
