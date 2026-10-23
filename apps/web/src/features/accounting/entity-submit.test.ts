import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type components } from '@sesame-notes/api-client';
import { createCategorySubmitter, createLedgerSubmitter } from './entity-submit';
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
beforeEach(() => vi.clearAllMocks());

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
  it('resolves an earlier unknown write before applying changed input to the same ledger', async () => {
    api.POST.mockRejectedValue(new TypeError('lost response'));
    api.GET.mockRejectedValueOnce(new TypeError('still offline')).mockResolvedValue({ data: ledger });
    api.PATCH.mockResolvedValue({ data: { ...ledger, name: '家庭日常' } });
    const submit = createLedgerSubmitter();
    await expect(submit({ name: '家庭' })).rejects.toThrow('still offline');
    await expect(submit({ name: '家庭日常' })).resolves.toMatchObject({ name: '家庭日常' });
    expect(api.POST).toHaveBeenCalledTimes(1);
    expect(api.PATCH.mock.calls[0]?.[1]?.params.path.ledger_id).toBe(ledger.id);
    expect(api.PATCH.mock.calls[0]?.[1]?.body).not.toHaveProperty('currency');
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
  it('recovers a category only when its fixed ID and all submitted fields match', async () => {
    api.POST.mockImplementation(async () => {
      throw new ApiError(409, 'CONFLICT', '重复ID');
    });
    api.GET.mockImplementation(async () => ({
      data: [
        {
          ...api.POST.mock.calls[0]?.[1]?.body,
          icon: null,
          parent_id: null,
          updated_at: ledger.updated_at,
        },
      ],
    }));
    await expect(
      createCategorySubmitter(ledger.id)({ name: '餐饮', kind: 'expense', level: 1, sort_order: 3 }),
    ).resolves.toMatchObject({ name: '餐饮', sort_order: 3 });
    expect(api.POST).toHaveBeenCalledTimes(1);
    expect(api.PATCH).not.toHaveBeenCalled();
  });
});
