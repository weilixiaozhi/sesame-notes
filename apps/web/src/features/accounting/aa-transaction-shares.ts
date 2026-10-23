import type { components } from '@sesame-notes/api-client';
import { amountUnits } from './accounting-analytics';
const unitScale = 10_000_000_000n;

/** 明细人均分摊与移动端一致：先向下取到分，全部剩余精度归付款人。 */
export function transactionShares(
  transaction: components['schemas']['Transaction'],
  participants: readonly string[],
): Map<string, string> | null {
  if (transaction.aa_mode === '1' || !transaction.payer_member_id) return null;
  const total = amountUnits(transaction.native_amount);
  if (transaction.aa_mode === '2') {
    const shares = new Map(transaction.splits.map((split) => [split.member_id, split.amount]));
    if (
      shares.size !== transaction.splits.length ||
      shares.size === 0 ||
      [...shares.values()].reduce((sum, amount) => sum + amountUnits(amount), 0n) !== total
    )
      return null;
    return shares;
  }
  const ids = [...new Set(participants)];
  if (!ids.includes(transaction.payer_member_id)) return null;
  const each = (total / (100_000_000n * BigInt(ids.length))) * 100_000_000n;
  const remainder = total - each * BigInt(ids.length);
  return new Map(
    ids.map((id) => {
      const amount = each + (id === transaction.payer_member_id ? remainder : 0n);
      const fraction = String(amount % unitScale)
        .padStart(10, '0')
        .replace(/0+$/, '');
      return [id, fraction ? `${amount / unitScale}.${fraction}` : String(amount / unitScale)];
    }),
  );
}
