import type { Ledger, Prisma } from '@prisma/client';
import { requestFingerprint } from '../../shared/request-fingerprint.js';

/** 汇总账本破坏性操作的预览与版本指纹，阻止预览后新增或修改的数据被误删。 */
export async function ledgerActionPreview(tx: Prisma.TransactionClient, ledger: Ledger) {
  const [transactions, recurring, members] = await Promise.all([
    tx.transaction.findMany({
      where: { ledgerId: ledger.id },
      select: { id: true, revision: true, deletedAt: true },
      orderBy: { id: 'asc' },
    }),
    tx.recurringTransaction.findMany({
      where: { ledgerId: ledger.id },
      select: { id: true, updatedAt: true, deletedAt: true },
      orderBy: { id: 'asc' },
    }),
    tx.ledgerMember.findMany({
      where: { ledgerId: ledger.id },
      select: { id: true, status: true, role: true, updatedAt: true, archivedAt: true, archiveUpdatedAt: true },
      orderBy: { id: 'asc' },
    }),
  ]);
  return {
    name: ledger.name,
    currency: ledger.currency,
    sync_id: ledger.syncId,
    fingerprint: requestFingerprint({ ledger, transactions, recurring, members }),
    transaction_count: transactions.filter((row) => !row.deletedAt).length,
    recurring_count: recurring.filter((row) => !row.deletedAt).length,
    member_count: members.length,
  };
}
