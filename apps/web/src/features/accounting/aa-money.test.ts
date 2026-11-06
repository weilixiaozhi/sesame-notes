import { afterEach, expect, it, vi } from 'vitest';
import { convertSplitAmounts } from './aa-money';
import { sumAmounts } from './money';

afterEach(() => vi.restoreAllMocks());

it('原币指定分摊转本位币十位并精确回显，尾差始终归指定付款人', () => {
  const native = convertSplitAmounts(['0.01', '0.01', '0.01'], '0.03', '0.20', 0, 10);
  expect(native).toEqual(['0.0666666666', '0.0666666667', '0.0666666667']);
  expect(sumAmounts(native)).toBe('0.2');
  expect(convertSplitAmounts(native, '0.20', '0.03', 0, 2)).toEqual(['0.01', '0.01', '0.01']);
  expect(convertSplitAmounts(['0.01', '0.01', '0.01'], '0.03', '0.20', 1, 10)).toEqual([
    '0.0666666667',
    '0.0666666666',
    '0.0666666667',
  ]);
});

it('半偶舍入在十位和两位边界都按整数比例计算，回显合计保持原币金额', () => {
  expect(convertSplitAmounts(['1', '1', '2'], '4', '0.000000001', 2, 10)).toEqual([
    '0.0000000002',
    '0.0000000002',
    '0.0000000006',
  ]);
  expect(convertSplitAmounts(['1', '1', '2'], '4', '0.14', 2, 2)).toEqual(['0.04', '0.04', '0.06']);
  expect(convertSplitAmounts(['1', '1', '1'], '3', '1', 0, 2)).toEqual(['0.34', '0.33', '0.33']);
});

it('不匹配的原币合计和不可存储的极小分摊拒绝写入', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => convertSplitAmounts(['0.01', '0.01'], '0.03', '0.20', 0, 10)).toThrow('合计');
  expect(() => convertSplitAmounts(['0.01', '0.99'], '1', '0.0000000001', 1, 10)).toThrow('过小');
  expect(() => convertSplitAmounts(['0', '1'], '1', '1', 0, 10)).toThrow('无效');
});
