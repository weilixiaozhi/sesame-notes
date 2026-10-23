import { describe, expect, it } from 'vitest';

import { requiredDecimal } from '../src/modules/sync/testing.js';
import { POSITIVE_AMOUNT_PATTERN, RATE_PATTERN } from '../src/shared/contracts/scalars.js';

describe('同步领域 Decimal 解析', () => {
  it.each(['0x1', '0e1', '0,1', '0a1', '001', '1e2', '0', '-1', '0.10'])('金额和汇率都拒绝非规范文本 %s', (value) => {
    try {
      for (const pattern of [POSITIVE_AMOUNT_PATTERN, RATE_PATTERN]) {
        expect(() => requiredDecimal({ value }, 'value', pattern)).toThrow('value 必须是规范正 Decimal 字符串');
      }
    } catch (cause) {
      throw new Error('同步 Decimal 非规范文本校验失败', { cause });
    }
  });

  it('保留金额十位与汇率十八位的小数精度及整数上界', () => {
    try {
      for (const amount of ['0.0000000001', '9999999999999999999999999999.9999999999']) {
        expect(requiredDecimal({ amount }, 'amount')).toBe(amount);
      }
      for (const rate of ['0.000000000000000001', '99999999999999999999.999999999999999999']) {
        expect(requiredDecimal({ rate }, 'rate', RATE_PATTERN)).toBe(rate);
      }
      expect(() => requiredDecimal({ amount: '0.00000000001' }, 'amount')).toThrow('规范正 Decimal');
      expect(() => requiredDecimal({ rate: '0.0000000000000000001' }, 'rate', RATE_PATTERN)).toThrow('规范正 Decimal');
      expect(() => requiredDecimal({ amount: 1 }, 'amount')).toThrow('规范正 Decimal');
    } catch (cause) {
      throw new Error('同步 Decimal 精度边界校验失败', { cause });
    }
  });
});
