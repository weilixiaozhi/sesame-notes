import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { components } from '@sesame-notes/api-client';
import { createLedgerSubmitter } from './entity-submit';
const api = vi.hoisted(() => ({ POST: vi.fn(), GET: vi.fn(), PATCH: vi.fn() }));
vi.mock('../../lib/session', () => ({ api, captureSessionOperation: () => ({ client: api }) }));
const ledger: components['schemas']['Ledger'] = {
  id: 'saved',
  sync_id: 'sync',
  name: '家庭',
  currency: 'CNY',
  month_start_day: 1,
  aa_enabled: false,
  archived_at: null,
  archive_updated_at: null,
  archive_device_id: null,
  role: 'owner',
  member_count: 1,
  updated_at: '2026-09-01T00:00:00.000Z',
};
beforeEach(() => vi.resetAllMocks());

describe('creation recovery with fixed entity identity', () => {
  it('recovers a committed ledger after the creation response was lost without another POST', async () => {
    api.POST.mockRejectedValue(new TypeError('lost response'));
    api.GET.mockResolvedValue({ data: ledger });
    const submit = createLedgerSubmitter();
    await expect(submit({ name: '家庭' })).resolves.toEqual(ledger);
    await expect(submit({ name: '家庭' })).resolves.toEqual(ledger);
    expect(api.POST).toHaveBeenCalledTimes(1);
    expect(api.PATCH).not.toHaveBeenCalled();
    expect(api.GET.mock.calls[0]?.[1]?.params.path.ledger_id).toBe(api.POST.mock.calls[0]?.[1]?.body.id);
  });

  it('修改未落库时重试冻结的原请求，再提交后来改变的草稿', async () => {
    try {
      let stored = { ...ledger };
      api.POST.mockResolvedValue({ data: { ...stored } });
      api.GET.mockImplementation(async () => ({ data: { ...stored } }));
      api.PATCH.mockRejectedValueOnce(new TypeError('发送失败')).mockImplementation(async (_path, options) => {
        stored = { ...stored, name: options.body.name };
        return { data: { ...stored } };
      });
      const submit = createLedgerSubmitter();
      await submit({ name: ledger.name });
      const draft = { name: '中间修改' };
      await expect(submit(draft)).rejects.toThrow('发送失败');
      draft.name = '最终修改';
      await expect(submit(draft)).resolves.toMatchObject({ name: '最终修改' });
      expect(stored.name).toBe('最终修改');
      expect(api.PATCH.mock.calls.map(([, options]) => options.body.name)).toEqual([
        '中间修改',
        '中间修改',
        '最终修改',
      ]);
      expect(api.POST).toHaveBeenCalledTimes(1);
    } catch (cause) {
      throw new Error('未落库修改的冻结恢复或后续草稿保存失败', { cause });
    }
  });
  it('does not overwrite a recovered entity whose server content has already changed', async () => {
    api.POST.mockRejectedValue(new TypeError('lost response'));
    api.GET.mockResolvedValue({ data: { ...ledger, name: '其他设备已编辑' } });
    await expect(createLedgerSubmitter()({ name: '家庭' })).rejects.toThrow('上次创建的内容已发生变化');
    expect(api.PATCH).not.toHaveBeenCalled();
  });
  it('requires the atomic currency flow when a recovered ledger creation has a different requested currency', async () => {
    api.POST.mockRejectedValue(new TypeError('lost response'));
    api.GET.mockRejectedValueOnce(new TypeError('offline')).mockResolvedValue({ data: ledger });
    const submit = createLedgerSubmitter();
    await expect(submit({ name: '家庭', currency: 'CNY' })).rejects.toThrow('offline');
    await expect(submit({ name: '家庭', currency: 'USD' })).rejects.toThrow('更换本位币');
    expect(api.PATCH).not.toHaveBeenCalled();
  });
});
