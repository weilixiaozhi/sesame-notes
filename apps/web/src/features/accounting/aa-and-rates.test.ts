import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { exchangeRateOverrideId } from './exchange-rate-id';
import { convertAmount } from './currency-math';
const accountId = '11111111-1111-4111-8111-111111111111';
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());
it('matches the server UUIDv5 namespace and rounds exact multiplication with half-even', async () => {
  await expect(exchangeRateOverrideId(accountId, 'CNY', 'USD')).resolves.toBe('203dbb72-b94e-5839-bec8-48a347f41c4a');
  expect(convertAmount('0.1', '7.5', 10)).toBe('0.75');
  expect(convertAmount('9999999999999999.1234567891', '1', 10)).toBe('9999999999999999.1234567891');
  expect(convertAmount('0.0000000001', '1.5', 10)).toBe('0.0000000002');
  expect(convertAmount('0.0000000001', '2.5', 10)).toBe('0.0000000002');
  expect(convertAmount('0.01', '1.5', 2)).toBe('0.02');
  expect(convertAmount('0.01', '2.5', 2)).toBe('0.02');
  expect(convertAmount('9999999999999999999999999999.99', '1', 2)).toBe('9999999999999999999999999999.99');
  expect(() => convertAmount('9999999999999999999999999999', '10', 10)).toThrow('超出');
});
