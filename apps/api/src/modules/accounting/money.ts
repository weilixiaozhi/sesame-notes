import { ANY_UUID_PATTERN, POSITIVE_AMOUNT_PATTERN } from '../../shared/contracts/scalars.js';

export type AaSplitInput = {
  member_id?: string | null;
  amount: string;
};

/** 按协议的十位小数精确求和，整数运算保留大额分摊中的每个最小金额单位。 */
export function validateAaSplitTotals(nativeAmount: string, splits: AaSplitInput[]): void {
  try {
    const amountPattern = new RegExp(POSITIVE_AMOUNT_PATTERN);
    // 参与人 id 为账本级 member_id（REGISTERED 派生 v5 / PLACEHOLDER v4），统一任意版本
    const uuidPattern = new RegExp(ANY_UUID_PATTERN);
    if (!amountPattern.test(nativeAmount)) throw new Error('INVALID_AA_SPLIT_DECIMAL');

    const participants = new Set<string>();
    for (const split of splits) {
      const memberId = split.member_id ?? null;
      if (memberId === null || !uuidPattern.test(memberId)) throw new Error('INVALID_AA_PARTICIPANT');
      if (!amountPattern.test(split.amount)) throw new Error('INVALID_AA_SPLIT_DECIMAL');

      const participantKey = `member:${memberId}`;
      if (participants.has(participantKey)) throw new Error('DUPLICATE_AA_PARTICIPANT');
      participants.add(participantKey);
    }

    // 每项已通过金额格式校验，统一放大到十位小数后用 BigInt 相加，求和过程不发生舍入。
    const total = splits.reduce((sum, split) => sum + amountToUnits(split.amount), 0n);
    if (total !== amountToUnits(nativeAmount)) throw new Error('AA_SPLIT_TOTAL_MISMATCH');
  } catch (error) {
    if (
      error instanceof Error &&
      [
        'AA_SPLIT_TOTAL_MISMATCH',
        'INVALID_AA_SPLIT_DECIMAL',
        'INVALID_AA_PARTICIPANT',
        'DUPLICATE_AA_PARTICIPANT',
      ].includes(error.message)
    ) {
      throw error;
    }
    throw new Error('INVALID_AA_SPLIT_DECIMAL', { cause: error });
  }
}

/** 把已校验的规范正金额转为十位小数整数单位，避免有效数字精度限制吞掉小额分摊。 */
function amountToUnits(value: string): bigint {
  try {
    const [integer, fraction = ''] = value.split('.');
    return BigInt(`${integer}${fraction.padEnd(10, '0')}`);
  } catch (cause) {
    throw new Error('INVALID_AA_SPLIT_DECIMAL', { cause });
  }
}

/** 校验 AA 模式与指定金额字段组合，避免无意义字段在多端产生不同解释。 */
export function validateAaFields(
  nativeAmount: string,
  mode: 0 | 1 | 2 | null | undefined,
  splits: AaSplitInput[] | null | undefined,
): void {
  try {
    if (mode === 2) {
      if (!splits || splits.length === 0) throw new Error('AA_SPLITS_REQUIRED');
      validateAaSplitTotals(nativeAmount, splits);
      return;
    }
    if (splits && splits.length > 0) throw new Error('AA_SPLITS_NOT_ALLOWED');
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error('INVALID_AA_SPLITS', { cause: error });
  }
}
