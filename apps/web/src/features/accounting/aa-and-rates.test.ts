import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { components } from '@sesame-notes/api-client';
import { exchangeRateOverrideId } from './exchange-rate-id';
import { convertAmount } from './currency-math';
import { transactionShares } from './aa-transaction-shares';
const accountId = '11111111-1111-4111-8111-111111111111';
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());
const transaction: components['schemas']['Transaction'] = {
  id: 'tx',
  ledger_id: 'ledger',
  tx_type: 'expense',
  amount: '10.0000000001',
  native_amount: '10.0000000001',
  currency_code: 'CNY',
  happened_at: '2026-09-01T00:00:00.000Z',
  category_id: null,
  category_name: null,
  category_kind: null,
  recurring_id: null,
  occurrence_date: null,
  created_by_member_id: null,
  last_edited_by_member_id: null,
  last_edited_at: null,
  created_at: '2026-09-01T00:00:00.000Z',
  note: null,
  aa_mode: '0',
  payer_member_id: 'a',
  splits: [],

  revision: 1,
  updated_at: '2026-09-01T00:00:00.000Z',
};
it('matches the server UUIDv5 namespace and rounds exact multiplication with half-even', async () => {
  await expect(exchangeRateOverrideId(accountId, 'CNY', 'USD')).resolves.toBe('203dbb72-b94e-5839-bec8-48a347f41c4a');
  expect(convertAmount('0.1', '7.5', 10)).toBe('0.75');
  expect(convertAmount('0.0000000001', '1.5', 10)).toBe('0.0000000002');
  expect(convertAmount('0.0000000001', '2.5', 10)).toBe('0.0000000002');
  expect(convertAmount('0.01', '1.5', 2)).toBe('0.02');
  expect(convertAmount('0.01', '2.5', 2)).toBe('0.02');
  expect(convertAmount('9999999999999999999999999999.99', '1', 2)).toBe('9999999999999999999999999999.99');
  expect(() => convertAmount('9999999999999999999999999999', '10', 10)).toThrow('超出');
});

it('assigns exact sub-cent remainder to the payer', () => {
  expect(transactionShares(transaction, ['a', 'b', 'c'])).toEqual(
    new Map([
      ['a', '3.3400000001'],
      ['b', '3.33'],
      ['c', '3.33'],
    ]),
  );
});

it('keeps exact custom shares and rejects broken or duplicate splits', () => {
  expect(
    transactionShares(
      {
        ...transaction,
        aa_mode: '2',
        splits: [
          { member_id: 'a', amount: '1' },
          { member_id: 'b', amount: '9.0000000001' },
        ],
      },
      ['a', 'b'],
    ),
  ).toEqual(
    new Map([
      ['a', '1'],
      ['b', '9.0000000001'],
    ]),
  );
  expect(
    transactionShares({ ...transaction, aa_mode: '2', splits: [{ member_id: 'a', amount: '10' }] }, ['a']),
  ).toBeNull();
  expect(
    transactionShares(
      {
        ...transaction,
        aa_mode: '2',
        splits: [
          { member_id: 'a', amount: '1' },
          { member_id: 'a', amount: '9.0000000001' },
        ],
      },
      ['a'],
    ),
  ).toBeNull();
  expect(transactionShares({ ...transaction, aa_mode: '1' }, ['a', 'b'])).toBeNull();
  expect(transactionShares({ ...transaction, payer_member_id: null }, ['a', 'b'])).toBeNull();
});
