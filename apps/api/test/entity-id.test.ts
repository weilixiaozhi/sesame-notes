import { describe, expect, it } from 'vitest';

import { exchangeRateOverrideId } from '../src/modules/accounting/index.js';

describe('汇率覆盖确定性 UUID', () => {
  it('使用冻结命名空间和规范币种生成跨端一致的 UUID v5', () => {
    expect(exchangeRateOverrideId('018f7f95-4b8a-4f5e-8d0c-2ebf4682c761', 'cny', 'usd')).toBe(
      '1527ffc3-6087-5b6b-99c6-c6837a5db1b6',
    );
  });
});
