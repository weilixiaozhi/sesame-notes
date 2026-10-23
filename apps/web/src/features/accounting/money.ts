/** 规范化用户输入的十进制金额，全程保留字符串精度。 */
export function canonicalAmount(input: string): string | null {
  const cleaned = input.trim();
  if (!/^\d+(?:\.\d{1,10})?$/.test(cleaned)) return null;
  const [integer = '', fraction = ''] = cleaned.split('.');
  const whole = integer.replace(/^0+(?=\d)/, '');
  const decimal = fraction.replace(/0+$/, '');
  if (whole.length > 28 || (whole === '0' && decimal === '')) return null;
  return decimal ? `${whole}.${decimal}` : whole;
}

/** 手工记账金额与客户端键盘一致，正数最多保留两位小数。 */
export function canonicalEntryAmount(input: string): string | null {
  const cleaned = input.trim();
  if (!/^\d{1,28}(?:\.\d{0,2})?$/.test(cleaned)) return null;
  return canonicalAmount(cleaned.endsWith('.') ? `${cleaned}0` : cleaned);
}

/** 编辑器按分展示已有金额，使用银行家舍入避免二进制浮点改变尾数。 */
export function roundEntryAmount(input: string): string {
  try {
    const canonical = canonicalAmount(input);
    if (!canonical) throw new Error('金额无效，请重新填写。');
    const [whole = '0', fraction = ''] = canonical.split('.');
    const padded = fraction.padEnd(10, '0');
    let cents = BigInt(whole) * 100n + BigInt(padded.slice(0, 2));
    const remainder = BigInt(padded.slice(2));
    if (remainder > 50_000_000n || (remainder === 50_000_000n && cents % 2n === 1n)) cents += 1n;
    return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
  } catch (cause) {
    throw new Error('金额无法显示，请检查记录后重试。', { cause });
  }
}

/** 以契约允许的十位小数转换为 BigInt 整数求和，避免金额浮点误差。 */
export function sumAmounts(amounts: readonly string[]): string {
  const total = amounts.reduce((sum, value) => {
    const [whole = '0', fraction = ''] = value.split('.');
    return sum + BigInt(whole) * 10_000_000_000n + BigInt(fraction.padEnd(10, '0'));
  }, 0n);
  const whole = total / 10_000_000_000n;
  const fraction = (total % 10_000_000_000n).toString().padStart(10, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** 用字符串添加分组符，完整展示超出 Number 安全精度的金额。 */
export function displayAmount(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}.${fraction.padEnd(2, '0')}`;
}

/** 日期表单使用浏览器本地时区，保留用户看到的实际发生时间。 */
export function localDateTime(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
