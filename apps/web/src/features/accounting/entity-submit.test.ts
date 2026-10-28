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
beforeEach(() => vi.resetAllMocks());

describe('creation recovery with fixed entity identity', () => {
  it.each(['账本', '分类'])('%s 的后续修改结果未知时，回改初始草稿也必须更新真实云态', async (kind) => {
    try {
      let stored = { ...ledger, kind: 'expense', level: 1, parent_id: null, sort_order: 3, icon: null };
      let unreadable = true;
      api.POST.mockImplementation(async (_path, options) => {
        stored = { ...stored, ...options.body };
        throw new TypeError('创建回执丢失');
      });
      api.GET.mockImplementation(async () => {
        if (unreadable) throw new TypeError('暂时无法核对云态');
        return { data: kind === '账本' ? { ...stored } : [{ ...stored }] };
      });
      api.PATCH.mockImplementationOnce(async (_path, options) => {
        stored = {
          ...stored,
          ...Object.fromEntries(Object.entries(options.body).filter(([, value]) => value !== undefined)),
        };
        unreadable = true;
        throw new TypeError('修改回执丢失');
      }).mockImplementation(async (_path, options) => {
        stored = {
          ...stored,
          ...Object.fromEntries(Object.entries(options.body).filter(([, value]) => value !== undefined)),
        };
        return { data: { ...stored } };
      });
      const categorySubmit = createCategorySubmitter(ledger.id);
      const submit =
        kind === '账本'
          ? createLedgerSubmitter()
          : (body: { name: string }) => categorySubmit({ ...body, kind: 'expense', level: 1, sort_order: 3 });
      await expect(submit({ name: '最初内容' })).rejects.toThrow();
      unreadable = false;
      await expect(submit({ name: '后续修改' })).rejects.toThrow();
      expect(stored.name).toBe('后续修改');
      unreadable = false;
      const result = await submit({ name: '最初内容' });
      expect(result.name).toBe('最初内容');
      expect(stored.name).toBe(result.name);
      expect(api.POST).toHaveBeenCalledTimes(1);
      expect(api.PATCH).toHaveBeenCalledTimes(2);
      expect(api.PATCH.mock.calls[1]?.[1]?.body.name).toBe('最初内容');
    } catch (cause) {
      throw new Error('未知修改被旧确认指纹掩盖，返回内容与真实云态不一致', { cause });
    }
  });

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

  it('修改已落库时读取确认同一草稿，后续相同成功提交不重复写入', async () => {
    try {
      let stored = { ...ledger };
      api.POST.mockResolvedValue({ data: { ...stored } });
      api.GET.mockImplementation(async () => ({ data: { ...stored } }));
      api.PATCH.mockImplementation(async (_path, options) => {
        stored = { ...stored, name: options.body.name };
        throw new TypeError('修改回执丢失');
      });
      const submit = createLedgerSubmitter();
      await submit({ name: ledger.name });
      await expect(submit({ name: '已修改' })).rejects.toThrow();
      await expect(submit({ name: '已修改' })).resolves.toMatchObject({ name: stored.name });
      await expect(submit({ name: '已修改' })).resolves.toMatchObject({ name: stored.name });
      expect(api.GET).toHaveBeenCalledTimes(1);
      expect(api.PATCH).toHaveBeenCalledTimes(1);
    } catch (cause) {
      throw new Error('已落库修改未被读取确认或被重复写入', { cause });
    }
  });

  it.each(['读取失败', '第三方修改'])('未知修改恢复遇到%s时保留失败，不返回旧成功内容', async (scenario) => {
    try {
      let stored = { ...ledger };
      api.POST.mockResolvedValue({ data: { ...stored } });
      api.PATCH.mockImplementation(async (_path, options) => {
        stored = { ...stored, name: options.body.name };
        throw new TypeError('修改回执丢失');
      });
      const submit = createLedgerSubmitter();
      await submit({ name: ledger.name });
      await expect(submit({ name: '未确认内容' })).rejects.toThrow();
      if (scenario === '读取失败') api.GET.mockRejectedValue(new TypeError('读取仍失败'));
      else {
        stored = { ...stored, name: '其他设备内容' };
        api.GET.mockResolvedValue({ data: { ...stored } });
      }
      const success = vi.fn();
      await expect(submit({ name: ledger.name }).then(success)).rejects.toThrow(
        scenario === '读取失败' ? '读取仍失败' : '上次修改的内容已发生变化',
      );
      expect(success).not.toHaveBeenCalled();
      expect(api.PATCH).toHaveBeenCalledTimes(1);
      expect(stored.name).toBe(scenario === '读取失败' ? '未确认内容' : '其他设备内容');
    } catch (cause) {
      throw new Error('无法确认的修改被伪装成保存成功', { cause });
    }
  });

  it.each([404, 409])('修改被HTTP %s拒绝后，回改初始草稿也必须重新核对云态', async (status) => {
    try {
      api.POST.mockResolvedValue({ data: { ...ledger } });
      api.PATCH.mockRejectedValue(new ApiError(status, 'ENTITY_CHANGED', '记录状态变化'));
      if (status === 404) api.GET.mockRejectedValue(new ApiError(404, 'LEDGER_NOT_FOUND', '账本不存在'));
      else api.GET.mockResolvedValue({ data: { ...ledger, name: '其他设备内容' } });
      const submit = createLedgerSubmitter();
      await submit({ name: ledger.name });
      await expect(submit({ name: '后续修改' })).rejects.toThrow('记录状态变化');
      const success = vi.fn();
      await expect(submit({ name: ledger.name }).then(success)).rejects.toThrow(
        status === 404 ? '记录已不存在' : '上次修改的内容已发生变化',
      );
      expect(success).not.toHaveBeenCalled();
      expect(api.GET).toHaveBeenCalledTimes(1);
      expect(api.PATCH).toHaveBeenCalledTimes(1);
    } catch (cause) {
      throw new Error('记录失效后旧成功指纹仍被复用', { cause });
    }
  });

  it('明确拒绝的修改在权威内容未变化时允许回到原草稿，不重试被拒绝的载荷', async () => {
    try {
      api.POST.mockResolvedValue({ data: { ...ledger } });
      api.PATCH.mockRejectedValue(new ApiError(409, 'CATEGORY_NAME_EXISTS', '名称冲突'));
      api.GET.mockResolvedValue({ data: { ...ledger } });
      const submit = createLedgerSubmitter();
      await submit({ name: ledger.name });
      await expect(submit({ name: '冲突名称' })).rejects.toThrow('名称冲突');
      await expect(submit({ name: ledger.name })).resolves.toMatchObject({ name: ledger.name });
      expect(api.GET).toHaveBeenCalledTimes(1);
      expect(api.PATCH).toHaveBeenCalledTimes(1);
    } catch (cause) {
      throw new Error('明确拒绝后的权威核对无法恢复原草稿', { cause });
    }
  });

  it('本地币种流程拒绝不会留下未知写入，合法原币草稿仍可确认', async () => {
    try {
      api.POST.mockResolvedValue({ data: { ...ledger } });
      const submit = createLedgerSubmitter();
      await submit({ name: ledger.name });
      await expect(submit({ name: ledger.name, currency: 'USD' })).rejects.toThrow('更换本位币');
      await expect(submit({ name: ledger.name })).resolves.toMatchObject({ currency: 'CNY' });
      expect(api.GET).not.toHaveBeenCalled();
      expect(api.PATCH).not.toHaveBeenCalled();
    } catch (cause) {
      throw new Error('明确的本地拒绝被误记为未知写入', { cause });
    }
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
