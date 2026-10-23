import { canonicalAmount, canonicalEntryAmount } from './money';

/** 正十进制统一为十位整数，分摊比例运算不经过浮点数或近似汇率。 */
function splitUnits(value: string): bigint {
  const canonical = canonicalAmount(value);
  if (!canonical) throw new Error('分摊金额无效，请重新核对。');
  const [whole = '0', fraction = ''] = canonical.split('.');
  return BigInt(whole) * 10_000_000_000n + BigInt(fraction.padEnd(10, '0'));
}

/** 把整数金额还原为十进制字符串，回显的零值保留供用户调整。 */
function splitAmount(units: bigint, scale: 2 | 10): string {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const factor = 10n ** BigInt(scale);
  const fraction = (absolute % factor).toString().padStart(scale, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${absolute / factor}${fraction ? `.${fraction}` : ''}`;
}

/** 编辑按原币两位回显，落库按本位币十位计算；半偶舍入的尾差归付款人。 */
export function convertSplitAmounts(
  splits: readonly string[],
  fromTotal: string,
  toTotal: string,
  payerIndex: number,
  scale: 2 | 10,
): string[] {
  try {
    if (splits.length === 0) return [];
    const from = splitUnits(fromTotal);
    // 低于一分的已有金额回显为零，由表单要求重新填写正金额；存储换算仍只接受正数。
    const to = scale === 2 && /^0+(?:\.0+)?$/.test(toTotal) ? 0n : splitUnits(toTotal);
    const values = splits.map(splitUnits);
    if (values.reduce((sum, value) => sum + value, 0n) !== from)
      throw new Error('分摊合计与支出金额不一致，请重新核对。');
    const targetFactor = 10n ** BigInt(10 - scale);
    if (to % targetFactor !== 0n) throw new Error('分摊目标金额超出输入精度，请重新核对。');
    const total = to / targetFactor;
    const amounts = values.map((value) => {
      const numerator = value * total;
      let quotient = numerator / from;
      const remainder = numerator % from;
      if (remainder * 2n > from || (remainder * 2n === from && quotient % 2n === 1n)) quotient += 1n;
      return quotient;
    });
    const remainderIndex = payerIndex >= 0 && payerIndex < amounts.length ? payerIndex : amounts.length - 1;
    amounts[remainderIndex] = amounts[remainderIndex]! + total - amounts.reduce((sum, value) => sum + value, 0n);
    // 本位币持久化要求每人金额为正；过小的折算结果必须由用户调整，不能静默丢失参与人。
    if (scale === 10 && amounts.some((amount) => amount <= 0n))
      throw new Error('折算后有参与人的分摊金额过小，请调整金额或参与人。');
    return amounts.map((amount) => splitAmount(amount, scale));
  } catch (cause) {
    console.error('换算 AA 分摊金额失败', { scale, participantCount: splits.length, cause });
    throw cause;
  }
}

/** 手工指定分摊按分均分，尾差归付款人。 */
export function equalAmounts(total: string, count: number, payerIndex: number): string[] {
  const canonical = canonicalEntryAmount(total);
  if (!canonical || !Number.isInteger(count) || count < 1 || count > 100) throw new Error('请先填写金额并选择参与人。');
  const [whole = '0', fraction = ''] = canonical.split('.');
  const scale = 2;
  const factor = 10n ** BigInt(scale);
  const units = BigInt(whole) * factor + BigInt(fraction.padEnd(scale, '0'));
  const part = units / BigInt(count);
  if (part === 0n) throw new Error('金额不足以分给当前人数，请减少参与人或手动填写精确分摊。');
  const remainder = units % BigInt(count);
  const target = payerIndex >= 0 && payerIndex < count ? payerIndex : count - 1;
  return Array.from({ length: count }, (_, index) => {
    const value = part + (index === target ? remainder : 0n);
    const digits = (value % factor).toString().padStart(scale, '0').replace(/0+$/, '');
    return digits ? `${value / factor}.${digits}` : String(value / factor);
  });
}
