import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type components } from '@sesame-notes/api-client';
import { createTransactionSubmitter } from './transaction-submit';
const mocks = vi.hoisted(() => ({ post: vi.fn(), patch: vi.fn(), get: vi.fn(), assertCurrent: vi.fn() }));
vi.mock('../../lib/session', () => ({
  api: { POST: mocks.post, PATCH: mocks.patch, GET: mocks.get },
  captureSessionOperation: () => ({
    client: { POST: mocks.post, PATCH: mocks.patch, GET: mocks.get },
    assertCurrent: mocks.assertCurrent,
  }),
}));
const ledger = { id: 'ledger', sync_id: 'generation' };
const saved: components['schemas']['Transaction'] = {
  id: 'saved-record',
  ledger_id: 'ledger',
  tx_type: 'expense',
  amount: '10',
  currency_code: 'CNY',
  native_amount: '10',
  happened_at: '2026-09-30T00:00:00.000Z',
  note: null,
  category_id: null,
  category_name: null,
  category_kind: null,

  recurring_id: null,
  occurrence_date: null,
  created_by_member_id: null,
  last_edited_by_member_id: null,
  payer_member_id: null,
  aa_mode: null,
  splits: [],
  revision: 1,
  last_edited_at: null,
  updated_at: '2026-09-30T00:00:00.000Z',
  created_at: '2026-09-30T00:00:00.000Z',
};
const input = {
  tx_type: 'expense' as const,
  amount: '10',
  currency_code: 'CNY',
  native_amount: '10',
  happened_at: '2026-09-30T00:00:00.000Z',
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.post.mockResolvedValue({ data: saved });
  mocks.patch.mockResolvedValue({ data: { ...saved, amount: '12', native_amount: '12', revision: 2 } });
  mocks.get.mockResolvedValue({ data: { ledger, members: [], transactions: [saved] } });
});
describe('transaction request identity', () => {
  it('replays an uncertain create exactly before applying changed input to the same record', async () => {
    mocks.post.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { submit } = createTransactionSubmitter(ledger, 'account');
    await expect(submit(input)).rejects.toThrow();
    await submit({ ...input, amount: '12', native_amount: '12' });
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[1]).toEqual(mocks.post.mock.calls[0]);
    expect(mocks.patch).toHaveBeenCalledWith(
      '/api/v1/ledgers/{ledger_id}/transactions/{transaction_id}',
      expect.objectContaining({
        params: { path: { ledger_id: 'ledger', transaction_id: 'saved-record' } },
        body: expect.objectContaining({ amount: '12', native_amount: '12', base_revision: 1 }),
      }),
    );
  });

  it('未知创建的嵌套分摊载荷保持冻结，后续输入修改不会改变幂等重放请求', async () => {
    const values = {
      ...input,
      aa_mode: '2' as const,
      splits: [
        { member_id: 'a', amount: '6' },
        { member_id: 'b', amount: '4' },
      ],
    };
    mocks.post.mockRejectedValueOnce(new TypeError('create response lost'));
    const { submit } = createTransactionSubmitter(ledger, 'account');
    await expect(submit(values)).rejects.toThrow();
    values.splits[0]!.amount = '5';
    values.splits[1]!.amount = '5';
    await submit(values);
    expect(mocks.post.mock.calls[0]).toEqual(mocks.post.mock.calls[1]);
    expect(mocks.post.mock.calls[1]?.[1]?.body.splits).toEqual([
      { member_id: 'a', amount: '6' },
      { member_id: 'b', amount: '4' },
    ]);
    expect(mocks.patch.mock.calls[0]?.[1]?.body.splits).toEqual(values.splits);
  });

  it('未知创建重放前校验账本代次，换号后所有恢复操作均被阻断', async () => {
    mocks.post.mockRejectedValueOnce(new TypeError('create response lost'));
    const { submit } = createTransactionSubmitter(ledger, 'account');
    await expect(submit(input)).rejects.toThrow();
    mocks.get.mockResolvedValueOnce({
      data: { ledger: { ...ledger, sync_id: 'new-generation' }, members: [], transactions: [] },
    });
    await expect(submit(input)).rejects.toThrow('账本已发生变化');
    expect(mocks.post).toHaveBeenCalledTimes(1);
    mocks.assertCurrent.mockImplementation(() => {
      throw new ApiError(401, 'SESSION_CHANGED', 'session changed');
    });
    await expect(submit(input)).rejects.toThrow('session changed');
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.patch).not.toHaveBeenCalled();
  });
});
