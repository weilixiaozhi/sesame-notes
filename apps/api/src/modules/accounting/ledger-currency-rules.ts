import { POSITIVE_AMOUNT_PATTERN, RATE_PATTERN } from '../../shared/contracts/scalars.js';
import { ApiError } from '../../shared/errors.js';
import { validateAaFields } from './money.js';

type CurrencyTransaction = {
  amount: string;
  nativeAmount: string;
  currencyCode: string;
  aaMode: 0 | 1 | 2 | null;
  payerMemberId: string | null;
  splits: Array<{ memberId: string; amount: string }>;
};

/** 与移动端一致按十位小数、银行家舍入换算，使用整数避免大金额被浮点或 Decimal 默认精度截断。 */
export function recalculateCurrencyTransaction(
  transaction: CurrencyTransaction,
  currency: string,
  rates: Record<string, string>,
) {
  try {
    const rate = transaction.currencyCode === currency ? '1' : rates[transaction.currencyCode];
    if (!rate)
      throw new ApiError(400, 'EXCHANGE_RATE_REQUIRED', `缺少 ${transaction.currencyCode} 到 ${currency} 的汇率`);
    if (!new RegExp(RATE_PATTERN).test(rate)) throw new ApiError(400, 'INVALID_EXCHANGE_RATE', '汇率必须为有效正数');
    const nativeUnits = roundRatio(units(transaction.amount, 10) * units(rate, 18), 10n ** 18n);
    const nativeAmount = money(nativeUnits);
    validateAaFields(
      transaction.nativeAmount,
      transaction.aaMode,
      transaction.splits.map((split) => ({ member_id: split.memberId, amount: split.amount })),
    );
    const splits = transaction.splits
      .map((split) => ({ ...split }))
      .sort((left, right) => left.memberId.localeCompare(right.memberId));
    if (splits.length) {
      const oldTotal = units(transaction.nativeAmount, 10);
      const scaled = splits.map((split) => roundRatio(units(split.amount, 10) * nativeUnits, oldTotal));
      const payerIndex = splits.findIndex((split) => split.memberId === transaction.payerMemberId);
      const remainderIndex = payerIndex < 0 ? scaled.length - 1 : payerIndex;
      scaled[remainderIndex] = scaled[remainderIndex]! + nativeUnits - scaled.reduce((sum, value) => sum + value, 0n);
      for (const [index, split] of splits.entries()) split.amount = money(scaled[index]!);
    }
    validateAaFields(
      nativeAmount,
      transaction.aaMode,
      splits.map((split) => ({ member_id: split.memberId, amount: split.amount })),
    );
    return { nativeAmount, splits };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'CURRENCY_RECALCULATION_INVALID', '现有交易或分摊金额无法安全换算，请检查记录后重试');
  }
}

/** 把无指数形式的十进制字符串转换为指定精度的整数。 */
function units(value: string, scale: number): bigint {
  const [integer = '', fraction = ''] = value.split('.');
  if (!/^\d+$/.test(integer) || !/^\d*$/.test(fraction) || fraction.length > scale) throw new Error('INVALID_DECIMAL');
  return BigInt(integer + fraction.padEnd(scale, '0'));
}

/** 正数分数精确舍入到整数，恰好一半时选择偶数。 */
function roundRatio(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n || numerator < 0n) throw new Error('INVALID_RATIO');
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return (
    quotient + (remainder * 2n > denominator || (remainder * 2n === denominator && quotient % 2n !== 0n) ? 1n : 0n)
  );
}

/** 金额必须能被当前数据库和同步契约精确表达，零值或溢出使整个操作失败。 */
function money(value: bigint): string {
  const result = `${value / 10n ** 10n}.${(value % 10n ** 10n).toString().padStart(10, '0')}`.replace(/\.?0+$/, '');
  if (!new RegExp(POSITIVE_AMOUNT_PATTERN).test(result))
    throw new ApiError(400, 'CURRENCY_AMOUNT_OUT_OF_RANGE', '换算结果超出金额精度或有效范围');
  return result;
}
