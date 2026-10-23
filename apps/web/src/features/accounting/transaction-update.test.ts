import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type components } from '@sesame-notes/api-client';
import { createTransactionUpdater, TransactionEditConflict } from './transaction-update';

const mocks = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), assertCurrent: vi.fn() }));
vi.mock('../../lib/session', () => ({
  captureSessionOperation: () => ({
    client: { GET: mocks.get, PATCH: mocks.patch },
    assertCurrent: mocks.assertCurrent,
  }),
}));
const ledger = { id: 'ledger', sync_id: 'generation' };
const original: components['schemas']['Transaction'] = {
  id: 'transaction',
  ledger_id: ledger.id,
  tx_type: 'expense',
  amount: '10',
  native_amount: '10',
  currency_code: 'CNY',
  happened_at: '2026-09-30T00:00:00.123Z',
  note: '原备注',
  category_id: null,
  category_name: null,
  category_kind: null,

  payer_member_id: null,
  aa_mode: null,
  splits: [],
  recurring_id: 'mobile-recurring-source',
  occurrence_date: '2026-09-30',
  revision: 7,
  created_by_member_id: null,
  last_edited_by_member_id: null,
  last_edited_at: null,
  updated_at: '2026-09-30T00:00:00.123Z',
  created_at: '2026-09-30T00:00:00.123Z',
};
const body = { amount: '12', native_amount: '12', note: '我的草稿', aa_mode: '0' as const };
const saved = { ...original, ...body, revision: 8 };

/** 构造权威账本快照，测试不依赖当前列表页是否包含目标交易。 */
function snapshot(transaction: components['schemas']['Transaction'] | null) {
  return { data: { ledger, transactions: transaction ? [transaction] : [], members: [] } };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.get.mockResolvedValue(snapshot(saved));
  mocks.patch.mockResolvedValue({ data: saved });
});

describe('编辑支出保存结果恢复', () => {
  it('提交成功但响应丢失时读取权威记录确认成功，同一草稿不重复更新', async () => {
    mocks.patch.mockRejectedValueOnce(new TypeError('response lost'));
    const updater = createTransactionUpdater(ledger, original, 'account');
    await expect(updater.submit(body)).resolves.toEqual(saved);
    await expect(updater.submit(body)).resolves.toEqual(saved);
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith('/api/v1/sync/full', {
      params: { query: { ledger_id: 'ledger', sync_id: 'generation' } },
    });
  });

  it('结果核对也断网后仍冻结原请求；再次保存先确认原结果再保存新增修改', async () => {
    mocks.patch.mockRejectedValueOnce(new TypeError('response lost'));
    mocks.get.mockRejectedValueOnce(new TypeError('offline'));
    const updater = createTransactionUpdater(ledger, original, 'account');
    await expect(updater.submit(body)).rejects.toThrow('暂时无法确认保存结果');
    const revised = { ...body, note: '后续草稿' };
    mocks.patch.mockResolvedValueOnce({ data: { ...saved, note: revised.note, revision: 9 } });
    await expect(updater.submit(revised)).resolves.toMatchObject({ note: revised.note, revision: 9 });
    expect(mocks.patch).toHaveBeenCalledTimes(2);
    expect(mocks.patch.mock.calls[1]?.[1]?.body).toMatchObject({ note: revised.note, base_revision: 8 });
  });

  it('请求未提交时用冻结基线重试，期间原请求提交导致 409 也能核对成功', async () => {
    mocks.patch
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockRejectedValueOnce(new ApiError(409, 'SYNC_CONFLICT', 'conflict'));
    mocks.get
      .mockResolvedValueOnce(snapshot(original))
      .mockResolvedValueOnce(snapshot(original))
      .mockResolvedValueOnce(snapshot(saved));
    const updater = createTransactionUpdater(ledger, original, 'account');
    await expect(updater.submit(body)).rejects.toThrow('offline');
    await expect(updater.submit(body)).resolves.toEqual(saved);
    expect(mocks.patch.mock.calls[0]).toEqual(mocks.patch.mock.calls[1]);
  });

  it('已有成功版本之后又有未知修改时，恢复旧草稿也必须先核对未知修改', async () => {
    const updater = createTransactionUpdater(ledger, original, 'account');
    await updater.submit(body);
    mocks.patch.mockRejectedValueOnce(new TypeError('response lost'));
    mocks.get.mockRejectedValueOnce(new TypeError('offline'));
    const later = { ...body, note: '后续修改' };
    await expect(updater.submit(later)).rejects.toThrow('暂时无法确认保存结果');
    mocks.get.mockResolvedValueOnce(snapshot({ ...saved, note: later.note, revision: 9 }));
    mocks.patch.mockResolvedValueOnce({ data: { ...saved, revision: 10 } });
    await expect(updater.submit(body)).resolves.toMatchObject({ note: body.note, revision: 10 });
    expect(mocks.patch).toHaveBeenCalledTimes(3);
    expect(mocks.patch.mock.calls[2]?.[1]?.body).toMatchObject({ note: body.note, base_revision: 9 });
  });

  it('真实并发修改保留草稿且不自动重发，只接受用户核对的版本，后续竞争仍返回冲突', async () => {
    const remote = { ...saved, note: '另一设备的备注', revision: 9 };
    mocks.patch.mockRejectedValue(new ApiError(409, 'SYNC_CONFLICT', 'conflict'));
    mocks.get.mockResolvedValue(snapshot(remote));
    const updater = createTransactionUpdater(ledger, original, 'account');
    const error = await updater.submit(body).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransactionEditConflict);
    await expect(updater.submit(body)).rejects.toBe(error);
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(() => updater.acceptReviewed({ ...remote })).toThrow('云端版本已变化');
    updater.acceptReviewed((error as TransactionEditConflict).current);
    mocks.get.mockResolvedValue(snapshot({ ...remote, revision: 10, note: '再次并发修改' }));
    await expect(updater.submit(body)).rejects.toBeInstanceOf(TransactionEditConflict);
    expect(mocks.patch.mock.calls[1]?.[1]?.body).toMatchObject({ ...body, base_revision: 9 });
    expect(mocks.patch).toHaveBeenCalledTimes(2);
  });

  it('金额精度、分摊顺序、同一时间及默认付款人按服务端语义核对', async () => {
    const values = {
      ...body,
      payer_member_id: null,
      aa_mode: '2' as const,
      happened_at: '2026-09-30T08:00:00.123+08:00',
      splits: [
        { member_id: 'member-b', amount: '6.00' },
        { member_id: 'member-a', amount: '6' },
      ],
    };
    const actual = {
      ...saved,
      payer_member_id: 'member-a',
      aa_mode: '2' as const,
      splits: [
        { member_id: 'member-a', amount: '6' },
        { member_id: 'member-b', amount: '6' },
      ],
    };
    mocks.patch.mockRejectedValueOnce(new TypeError('response lost'));
    mocks.get
      .mockResolvedValueOnce(snapshot(actual))
      .mockResolvedValueOnce({ data: [{ user_id: 'account', member_id: 'member-a' }] });
    await expect(createTransactionUpdater(ledger, original, 'account').submit(values)).resolves.toEqual(actual);
    expect(mocks.patch).toHaveBeenCalledTimes(1);
  });

  it.each(['recurring_id', 'occurrence_date', 'category_id', 'payer_member_id'] as const)(
    '其他字段相同但 %s 变化时不能误认成功',
    async (field) => {
      mocks.patch.mockRejectedValueOnce(new TypeError('response lost'));
      mocks.get.mockResolvedValue(snapshot({ ...saved, [field]: 'different' }));
      await expect(createTransactionUpdater(ledger, original, 'account').submit(body)).rejects.toBeInstanceOf(
        TransactionEditConflict,
      );
      expect(mocks.patch).toHaveBeenCalledTimes(1);
    },
  );

  it('记录删除和账本代次变化不会被当作保存成功', async () => {
    mocks.patch.mockRejectedValue(new TypeError('response lost'));
    mocks.get.mockResolvedValueOnce(snapshot(null));
    await expect(createTransactionUpdater(ledger, original, 'account').submit(body)).rejects.toThrow('已被删除');
    mocks.get.mockResolvedValueOnce({
      data: { ...snapshot(saved).data, ledger: { ...ledger, sync_id: 'new-generation' } },
    });
    await expect(createTransactionUpdater(ledger, original, 'account').submit(body)).rejects.toThrow('账本已发生变化');
  });

  it('明确业务拒绝后可修正草稿，会话失效后不能再读取或提交', async () => {
    mocks.patch.mockRejectedValueOnce(new ApiError(400, 'INVALID_CATEGORY', '分类不可用'));
    const updater = createTransactionUpdater(ledger, original, 'account');
    await expect(updater.submit(body)).rejects.toThrow('分类不可用');
    expect(mocks.get).not.toHaveBeenCalled();
    await updater.submit({ ...body, note: '修正后的草稿' });
    expect(mocks.patch.mock.calls[1]?.[1]?.body.base_revision).toBe(7);
    mocks.assertCurrent.mockImplementation(() => {
      throw new ApiError(401, 'SESSION_CHANGED', 'session changed');
    });
    await expect(updater.submit(body)).rejects.toThrow('session changed');
    expect(mocks.patch).toHaveBeenCalledTimes(2);
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
