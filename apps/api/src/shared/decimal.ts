import { Prisma } from '@prisma/client';

/** 把 Prisma Decimal 或数字安全转成协议要求的规范化字符串。 */
export function decimalToCanonical(value: Prisma.Decimal.Value, scale = 10): string {
  try {
    const raw = new Prisma.Decimal(value).toDecimalPlaces(scale, Prisma.Decimal.ROUND_HALF_EVEN).toFixed(scale);
    const normalized = raw.includes('.') ? raw.replace(/(?:\.0+|(\.\d*?)0+)$/, '$1') : raw;
    return normalized === '-0' ? '0' : normalized;
  } catch (error) {
    throw new Error('DECIMAL_SERIALIZATION_FAILED', { cause: error });
  }
}
