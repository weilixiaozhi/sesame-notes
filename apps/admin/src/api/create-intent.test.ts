import { ApiError } from '@sesame-notes/api-client';
import { describe, expect, it, vi } from 'vitest';
import { createAdminCreation } from './create-intent';
import { invalidateAdminOperationScope } from './operation-scope';

type Draft = { name: string; settings: { enabled: boolean } };
type Saved = { id: string; version: number; name: string };

describe('管理新增意图恢复', () => {
  it('创建迟到成功也不能交付给新工作区，旧编辑器后续提交不再发请求', async () => {
    let finish!: (value: Saved) => void;
    const create = vi.fn(() => new Promise<Saved>((resolve) => (finish = resolve)));
    const update = vi.fn();
    const save = createAdminCreation<Draft, Saved>({ create, update });
    const result = save({ name: '旧草稿', settings: { enabled: true } });
    invalidateAdminOperationScope();
    finish({ id: 'already-created', version: 1, name: '旧草稿' });
    await expect(result).rejects.toMatchObject({ code: 'ADMIN_SESSION_CHANGED' });
    await expect(save({ name: '后续草稿', settings: { enabled: true } })).rejects.toMatchObject({
      code: 'ADMIN_SESSION_CHANGED',
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('已确认创建的编辑器在代际变化后不能更新，新工作区可建立自己的新意图', async () => {
    const entity: Saved = { id: 'saved', version: 1, name: '原内容' };
    const create = vi.fn(async () => entity);
    const update = vi.fn();
    const save = createAdminCreation<Draft, Saved>({ create, update });
    await expect(save({ name: '原内容', settings: { enabled: true } })).resolves.toEqual(entity);
    invalidateAdminOperationScope();
    await expect(save({ name: '修改', settings: { enabled: true } })).rejects.toMatchObject({
      code: 'ADMIN_SESSION_CHANGED',
    });
    expect(update).not.toHaveBeenCalled();
    const next = createAdminCreation<Draft, Saved>({ create, update });
    await expect(next({ name: '新意图', settings: { enabled: true } })).resolves.toEqual(entity);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('已发送的更新在会话变化后成功返回，不继续发布旧编辑器的成功结果', async () => {
    let finish!: (value: Saved) => void;
    const entity: Saved = { id: 'saved', version: 1, name: '原内容' };
    const create = vi.fn(async () => entity);
    const update = vi.fn(() => new Promise<Saved>((resolve) => (finish = resolve)));
    const save = createAdminCreation<Draft, Saved>({ create, update });
    await save({ name: '原内容', settings: { enabled: true } });
    const result = save({ name: '更新', settings: { enabled: true } });
    invalidateAdminOperationScope();
    finish({ ...entity, version: 2, name: '更新' });
    await expect(result).rejects.toMatchObject({ code: 'ADMIN_SESSION_CHANGED' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('提交后响应丢失时原键原载荷恢复，后续草稿更新同一实体', async () => {
    const writes: Array<{ key: string; body: Draft }> = [];
    const stored: Saved = { id: 'created-once', version: 1, name: '原内容' };
    const create = vi.fn(async (body: Draft, key: string) => {
      writes.push({ key, body: structuredClone(body) });
      if (writes.length === 1) throw new TypeError('成功响应在返回时丢失');
      return stored;
    });
    const update = vi.fn(async (saved: Saved, body: Draft) => ({
      ...saved,
      version: saved.version + 1,
      name: body.name,
    }));
    const save = createAdminCreation({ create, update });
    const original: Draft = { name: '原内容', settings: { enabled: true } };
    await expect(save(original)).rejects.toThrow('响应');
    original.name = '后续草稿';
    original.settings.enabled = false;
    await expect(save(original)).resolves.toMatchObject({ id: stored.id, version: 2, name: '后续草稿' });
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]?.body).toEqual({ name: '原内容', settings: { enabled: true } });
    expect(update).toHaveBeenCalledWith(stored, original, writes[0]?.body);
  });

  it('首次明确校验拒绝后可以修正为新意图', async () => {
    const create = vi
      .fn<(body: Draft, key: string) => Promise<Saved>>()
      .mockRejectedValueOnce(new ApiError(400, 'VALIDATION_ERROR', '输入无效'))
      .mockResolvedValue({ id: 'saved', version: 1, name: '正确' });
    const save = createAdminCreation({ create, update: vi.fn() });
    await expect(save({ name: '', settings: { enabled: true } })).rejects.toMatchObject({ status: 400 });
    await expect(save({ name: '正确', settings: { enabled: true } })).resolves.toMatchObject({ id: 'saved' });
    expect(create.mock.calls[1]?.[1]).not.toBe(create.mock.calls[0]?.[1]);
    expect(create.mock.calls[1]?.[0].name).toBe('正确');
  });

  it('未知提交后重放遇到撤权也保留原意图，恢复权限后不新增第二实体', async () => {
    const create = vi
      .fn<(body: Draft, key: string) => Promise<Saved>>()
      .mockRejectedValueOnce(new TypeError('连接断开'))
      .mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', '已撤权'))
      .mockResolvedValue({ id: 'first-entity', version: 1, name: '原内容' });
    const update = vi.fn(async (saved: Saved, body: Draft) => ({ ...saved, version: 2, name: body.name }));
    const save = createAdminCreation({ create, update });
    await expect(save({ name: '原内容', settings: { enabled: true } })).rejects.toThrow('连接');
    await expect(save({ name: '新内容', settings: { enabled: false } })).rejects.toMatchObject({ status: 403 });
    await expect(save({ name: '新内容', settings: { enabled: false } })).resolves.toMatchObject({ id: 'first-entity' });
    expect(new Set(create.mock.calls.map((call) => call[1])).size).toBe(1);
    expect(create.mock.calls.every((call) => call[0].name === '原内容')).toBe(true);
  });

  it('服务端键冲突不通过自动更换键规避', async () => {
    const create = vi
      .fn<(body: Draft, key: string) => Promise<Saved>>()
      .mockRejectedValue(new ApiError(409, 'ADMIN_CREATION_KEY_REUSED', '键被复用'));
    const save = createAdminCreation({ create, update: vi.fn() });
    await expect(save({ name: '原内容', settings: { enabled: true } })).rejects.toMatchObject({ status: 409 });
    await expect(save({ name: '新内容', settings: { enabled: false } })).rejects.toMatchObject({ status: 409 });
    expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
  });

  it('没有业务错误载荷的代理 HTTP 错误仍按未知结果保留原意图', async () => {
    const create = vi
      .fn<(body: Draft, key: string) => Promise<Saved>>()
      .mockRejectedValueOnce(new ApiError(403, 'HTTP_403', '代理拒绝'))
      .mockResolvedValue({ id: 'existing', version: 1, name: '原内容' });
    const update = vi.fn(async (saved: Saved, body: Draft) => ({ ...saved, name: body.name }));
    const save = createAdminCreation({ create, update });
    await expect(save({ name: '原内容', settings: { enabled: true } })).rejects.toMatchObject({ status: 403 });
    await save({ name: '修正', settings: { enabled: true } });
    expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
  });

  it('成功创建后重复确认不重发新增，更新失败也不退回新增分支', async () => {
    const original = { name: '原内容', settings: { enabled: true } };
    const saved = { id: 'one', version: 1, name: original.name };
    const create = vi.fn(async () => saved);
    const update = vi.fn().mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT', '版本冲突'));
    const save = createAdminCreation<Draft, Saved>({ create, update });
    await expect(save(original)).resolves.toEqual(saved);
    await expect(save(original)).resolves.toEqual(saved);
    await expect(save({ ...original, name: '修改' })).rejects.toMatchObject({ status: 409 });
    await expect(save({ ...original, name: '修改' })).rejects.toMatchObject({ status: 409 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls.every((call) => call[0].id === saved.id && call[0].version === 1)).toBe(true);
  });

  it('创建恢复后的更新已提交但响应丢失，改回原草稿也必须向同一实体核验版本', async () => {
    const original: Draft = { name: 'A', settings: { enabled: true } };
    const receipt: Saved = { id: 'same-entity', version: 1, name: 'A' };
    let stored: Saved | undefined;
    /** 首次提交保存实体后丢失响应，重放始终返回首次创建的固定回执。 */
    const create = vi.fn(async (_body: Draft, _key: string) => {
      if (!stored) {
        stored = structuredClone(receipt);
        throw new TypeError('创建已提交但响应丢失');
      }
      return structuredClone(receipt);
    });
    /** 服务端更新先校验版本，首次更新提交后故意丢失成功响应。 */
    const update = vi.fn(async (saved: Saved, body: Draft) => {
      if (!stored || stored.version !== saved.version)
        throw new ApiError(409, 'VERSION_CONFLICT', '内容已变化，请刷新核对');
      stored = { ...stored, name: body.name, version: stored.version + 1 };
      throw new TypeError('更新已提交但响应丢失');
    });
    const save = createAdminCreation({ create, update });
    await expect(save(original)).rejects.toThrow('创建已提交');
    await expect(save({ ...original, name: 'B' })).rejects.toThrow('更新已提交');
    expect(stored).toEqual({ id: receipt.id, version: 2, name: 'B' });
    await expect(save(original)).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1]).toEqual([receipt, original, original]);
  });

  it.each([
    new TypeError('更新连接中断'),
    new DOMException('更新请求已中止', 'AbortError'),
    new ApiError(403, 'HTTP_403', '代理未返回业务结果'),
    new ApiError(404, 'ENTITY_NOT_FOUND', '实体已不存在'),
    new ApiError(409, 'VERSION_CONFLICT', '服务端版本已变化'),
  ])('更新结果未知或快照失效后，原草稿也必须重新核验：%s', async (failure) => {
    const original: Draft = { name: '原内容', settings: { enabled: true } };
    const entity: Saved = { id: 'saved', version: 1, name: original.name };
    const create = vi.fn(async () => entity);
    const update = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({ ...entity, version: 2 });
    const save = createAdminCreation<Draft, Saved>({ create, update });
    await save(original);
    await expect(save({ ...original, name: '修改' })).rejects.toBe(failure);
    await expect(save(original)).resolves.toEqual({ ...entity, version: 2 });
    await expect(save(original)).resolves.toEqual({ ...entity, version: 2 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1]).toEqual([entity, original, original]);
  });

  it('更新首次明确业务校验拒绝仍可确认原草稿，但未知后的撤权不能清除未确认状态', async () => {
    const original: Draft = { name: '原内容', settings: { enabled: true } };
    const entity: Saved = { id: 'saved', version: 1, name: original.name };
    const create = vi.fn(async () => entity);
    const update = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(400, 'VALIDATION_ERROR', '输入无效'))
      .mockRejectedValueOnce(new TypeError('更新结果未知'))
      .mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', '当前无权修改'))
      .mockRejectedValueOnce(new ApiError(409, 'VERSION_CONFLICT', '内容已变化'));
    const save = createAdminCreation<Draft, Saved>({ create, update });
    await save(original);
    await expect(save({ ...original, name: '校验错误' })).rejects.toMatchObject({ status: 400 });
    await expect(save(original)).resolves.toEqual(entity);
    expect(update).toHaveBeenCalledTimes(1);
    await expect(save({ ...original, name: '修改' })).rejects.toThrow('更新结果未知');
    await expect(save({ ...original, name: '修改' })).rejects.toMatchObject({ status: 403 });
    await expect(save(original)).rejects.toMatchObject({ status: 409 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(4);
    expect(update.mock.calls.every((call) => call[0].id === entity.id && call[0].version === entity.version)).toBe(
      true,
    );
  });

  it('同一编辑过程的连续提交共用在途请求', async () => {
    let complete: ((value: Saved) => void) | undefined;
    const create = vi.fn(() => new Promise<Saved>((resolve) => (complete = resolve)));
    const save = createAdminCreation<Draft, Saved>({ create, update: vi.fn() });
    const first = save({ name: '首个', settings: { enabled: true } });
    const second = save({ name: '后续', settings: { enabled: false } });
    expect(second).toBe(first);
    complete!({ id: 'one', version: 1, name: '首个' });
    await first;
    expect(create).toHaveBeenCalledTimes(1);
  });
});
