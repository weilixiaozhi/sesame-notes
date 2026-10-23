import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type components } from '@sesame-notes/api-client';
import { createTransactionSubmitter } from './transaction-submit';
import { TransactionEditConflict } from './transaction-update';
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
  it('retries a known rejected corrected request with a new key and the same entity identity', async () => {
    mocks.post.mockRejectedValueOnce(new ApiError(400, 'INVALID_CATEGORY', 'invalid'));
    const { submit } = createTransactionSubmitter(ledger, 'account');
    await expect(submit(input)).rejects.toThrow();
    await submit({ ...input, note: 'corrected' });
    expect(mocks.post.mock.calls[0]?.[1]?.body.id).toBe(mocks.post.mock.calls[1]?.[1]?.body.id);
    expect(mocks.post.mock.calls[0]?.[1]?.params.header['idempotency-key']).not.toBe(
      mocks.post.mock.calls[1]?.[1]?.params.header['idempotency-key'],
    );
    expect(mocks.patch).not.toHaveBeenCalled();
  });
  it('returns a confirmed save instead of creating another record on repeated completion', async () => {
    const { submit } = createTransactionSubmitter(ledger, 'account');
    await submit(input);
    await submit(input);
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it('新增重放确认后的修改响应丢失时，通过同一记录的权威状态确认，保持原创建幂等键', async () => {
    const revised = { ...input, amount: '12', native_amount: '12' };
    const updated = { ...saved, ...revised, revision: 2 };
    mocks.post.mockRejectedValueOnce(new TypeError('create response lost'));
    mocks.patch.mockRejectedValueOnce(new TypeError('patch response lost'));
    mocks.get.mockResolvedValue({ data: { ledger, members: [], transactions: [updated] } });
    const { submit } = createTransactionSubmitter(ledger, 'account');
    await expect(submit(input)).rejects.toThrow('create response lost');
    await expect(submit(revised)).resolves.toEqual(updated);
    await expect(submit(revised)).resolves.toEqual(updated);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[0]).toEqual(mocks.post.mock.calls[1]);
    expect(mocks.patch).toHaveBeenCalledTimes(1);
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

  it('修改结果未知后草稿改回最初内容，仍先恢复该修改再基于确认版本保存', async () => {
    const revised = { ...input, amount: '12', native_amount: '12' };
    const updated = { ...saved, ...revised, revision: 2 };
    const { submit } = createTransactionSubmitter(ledger, 'account');
    await submit(input);
    mocks.patch.mockRejectedValueOnce(new TypeError('patch response lost'));
    mocks.get.mockRejectedValueOnce(new TypeError('offline'));
    await expect(submit(revised)).rejects.toThrow('暂时无法确认保存结果');
    mocks.get.mockResolvedValueOnce({ data: { ledger, members: [], transactions: [updated] } });
    mocks.patch.mockResolvedValueOnce({ data: { ...saved, revision: 3 } });
    await expect(submit(input)).resolves.toMatchObject({ amount: '10', revision: 3 });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.patch.mock.calls[1]?.[1]?.body).toMatchObject({ amount: '10', base_revision: 2 });
  });

  it('新增后的真实编辑冲突也必须明确核对，不会重新创建或直接覆盖最新版本', async () => {
    const submitter = createTransactionSubmitter(ledger, 'account');
    await submitter.submit(input);
    const remote = { ...saved, note: '其他设备备注', revision: 3 };
    mocks.patch.mockRejectedValueOnce(new ApiError(409, 'SYNC_CONFLICT', 'conflict'));
    mocks.get.mockResolvedValue({ data: { ledger, members: [], transactions: [remote] } });
    const revised = { ...input, amount: '12', native_amount: '12' };
    const error = await submitter.submit(revised).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransactionEditConflict);
    await expect(submitter.submit(revised)).rejects.toBe(error);
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    submitter.acceptReviewed((error as TransactionEditConflict).current);
    await submitter.submit(revised);
    expect(mocks.patch.mock.calls[1]?.[1]?.body.base_revision).toBe(3);
    expect(mocks.post).toHaveBeenCalledTimes(1);
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
