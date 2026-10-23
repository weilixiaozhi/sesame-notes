import { canonicalAmount } from './money';

/** 汇率最多保留十八位小数，按接口要求规范化为正十进制字符串。 */
export function canonicalRate(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d{1,18})?$/.test(trimmed)) return null;
  const [integer = '0', fraction = ''] = trimmed.split('.');
  const whole = integer.replace(/^0+(?=\d)/, '');
  const decimal = fraction.replace(/0+$/, '');
  if (whole.length > 20 || (whole === '0' && !decimal)) return null;
  return decimal ? `${whole}.${decimal}` : whole;
}

/** 把“1 目标币对应多少原币”求倒数，使用整数与银行家舍入保证十八位精度。 */
export function inverseRate(value: string): string {
  const canonical = canonicalRate(value);
  if (!canonical) throw new Error('参考汇率无效，请手动填写。');
  const [integer = '0', fraction = ''] = canonical.split('.');
  const denominator = BigInt(`${integer}${fraction}`);
  const numerator = 10n ** BigInt(18 + fraction.length);
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n > denominator || (remainder * 2n === denominator && quotient % 2n === 1n)) quotient += 1n;
  const scale = 10n ** 18n;
  const digits = (quotient % scale).toString().padStart(18, '0').replace(/0+$/, '');
  const result = canonicalRate(digits ? `${quotient / scale}.${digits}` : String(quotient / scale));
  if (!result) throw new Error('参考汇率超出支持精度，请手动填写。');
  return result;
}

/** 十进制整数完成汇率换算；手工记账按分保存，导入按源数据精度保存。 */
export function convertAmount(amount: string, rate: string, scale: 2 | 10): string {
  const value = canonicalAmount(amount);
  const factor = canonicalRate(rate);
  if (!value || !factor) throw new Error('请输入有效的原币金额与汇率。');
  const [amountWhole = '0', amountFraction = ''] = value.split('.');
  const [rateWhole = '0', rateFraction = ''] = factor.split('.');
  const amountUnits = BigInt(amountWhole) * 10n ** 10n + BigInt(amountFraction.padEnd(10, '0'));
  const rateUnits = BigInt(rateWhole) * 10n ** 18n + BigInt(rateFraction.padEnd(18, '0'));
  const denominator = 10n ** BigInt(28 - scale);
  const product = amountUnits * rateUnits;
  let units = product / denominator;
  const remainder = product % denominator;
  if (remainder * 2n > denominator || (remainder * 2n === denominator && units % 2n === 1n)) units += 1n;
  const fraction = String(units % 10n ** BigInt(scale))
    .padStart(scale, '0')
    .replace(/0+$/, '');
  const result = canonicalAmount(
    fraction ? `${units / 10n ** BigInt(scale)}.${fraction}` : String(units / 10n ** BigInt(scale)),
  );
  if (!result) throw new Error('折算结果超出支持的金额精度，请检查金额和汇率。');
  return result;
}
