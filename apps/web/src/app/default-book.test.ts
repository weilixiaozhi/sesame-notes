import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@sesame-notes/api-client';
import { createDefaultBookProvisioner, type DefaultBookKind } from './default-book';

const mock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  push: vi.fn(),
  setQueryData: vi.fn(),
  capture: vi.fn(),
  cancelQueries: vi.fn(),
  invalidateQueries: vi.fn(),
  generation: 0,
}));
vi.mock('../lib/session', () => ({
  queryClient: {
    setQueryData: mock.setQueryData,
    cancelQueries: mock.cancelQueries,
    invalidateQueries: mock.invalidateQueries,
  },
  captureSessionOperation: () => {
    mock.capture();
    const expected = mock.generation;
    return {
      client: { GET: mock.get, POST: mock.post, PATCH: mock.patch },
      signal: new AbortController().signal,
      assertCurrent: () => {
        if (expected !== mock.generation) throw new ApiError(401, 'SESSION_CHANGED', '账号已切换');
      },
    };
  },
  createChangeBatch: () => {
    const expected = mock.generation;
    return {
      push: async (change: unknown) => {
        if (expected !== mock.generation) throw new ApiError(401, 'SESSION_CHANGED', '账号已切换');
        await mock.push(change);
        if (expected !== mock.generation) throw new ApiError(401, 'SESSION_CHANGED', '账号已切换');
      },
    };
  },
}));

type Book = {
  id: string;
  sync_id: string;
  name?: string;
  currency?: string;
  type?: string;
  archived_at?: string | null;
};
let books: Book[];
const paths: Record<DefaultBookKind, string> = {
  accounting: '/api/v1/ledgers',
  memos: '/api/v1/sync/memo-books',
  days: '/api/v1/sync/day-books',
  fitness: '/api/v1/sync/fitness-spaces',
};
const keys: Record<DefaultBookKind, string[]> = {
  accounting: ['account', 'user', 'accounting', 'ledgers'],
  memos: ['account', 'user', 'memo-books'],
  days: ['account', 'user', 'day-books'],
  fitness: ['account', 'user', 'fitness', 'spaces'],
};

/** 测试目录与实际接口使用相同容器形状，发布缓存必须保留完整快照。 */
function directory(path: string) {
  if (path === paths.accounting) return books;
  if (path === paths.memos) return { memo_books: books, server_cursor: '1' };
  if (path === paths.days) return { day_books: books, server_cursor: '1' };
  return { fitness_spaces: books, server_cursor: '1' };
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.generation = 0;
  books = [];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mock.get.mockImplementation(async (path: string, options?: { params?: { path?: { ledger_id?: string } } }) => {
    if (path === '/api/v1/profile/me') return { data: { user_id: 'user', primary_currency: 'SGD' } };
    if (path === '/api/v1/ledgers/{ledger_id}') {
      const saved = books.find((book) => book.id === options?.params?.path?.ledger_id);
      if (!saved) throw new ApiError(404, 'NOT_FOUND', '不存在');
      return { data: saved };
    }
    return { data: directory(path) };
  });
  mock.post.mockImplementation(
    async (_path: string, options: { body: { id: string; name: string; currency: string } }) => {
      const saved = {
        ...options.body,
        sync_id: 'server-sync',
        archived_at: null,
        month_start_day: 1,
        aa_enabled: false,
      };
      books = [saved];
      return { data: saved };
    },
  );
  mock.push.mockImplementation(async (change: { entity_id: string; payload: { name: string; type?: string } }) => {
    books = [{ id: change.entity_id, sync_id: 'server-sync', ...change.payload }];
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('首条记录默认本准备', () => {
  it('创建工厂不捕获会话或发起请求', () => {
    createDefaultBookProvisioner('accounting', 'user');
    expect(mock.capture).not.toHaveBeenCalled();
    expect(mock.get).not.toHaveBeenCalled();
  });

  it.each<DefaultBookKind>(['accounting', 'memos', 'days', 'fitness'])(
    '复用已有 %s 云本并发布真实目录，不写入新本',
    async (kind) => {
      books = [{ id: 'existing', sync_id: 'existing-sync', type: 'normal', archived_at: null }];
      await expect(createDefaultBookProvisioner(kind, 'user')()).resolves.toBe('existing');
      expect(mock.post).not.toHaveBeenCalled();
      expect(mock.push).not.toHaveBeenCalled();
      expect(mock.setQueryData).toHaveBeenCalledWith(keys[kind], directory(paths[kind]));
    },
  );

  it.each<DefaultBookKind>(['accounting', 'memos', 'days', 'fitness'])(
    '空目录 %s 重复点击只创建一次并确认服务端绑定',
    async (kind) => {
      const provision = createDefaultBookProvisioner(kind, 'user');
      const first = provision();
      const second = provision();
      expect(first).toBe(second);
      const id = await first;
      await expect(provision()).resolves.toBe(id);
      expect(kind === 'accounting' ? mock.post : mock.push).toHaveBeenCalledTimes(1);
      expect(books[0]?.sync_id).toBe('server-sync');
      expect(mock.setQueryData).toHaveBeenLastCalledWith(keys[kind], directory(paths[kind]));
      if (kind === 'accounting') expect(mock.post.mock.calls[0]?.[1]?.body.currency).toBe('SGD');
      else expect(mock.push.mock.calls[0]?.[0]).not.toHaveProperty('sync_id');
    },
  );

  it('账本未知失败重试沿用同一个实体标识', async () => {
    mock.post.mockRejectedValueOnce(new TypeError('连接中断'));
    const provision = createDefaultBookProvisioner('accounting', 'user');
    await expect(provision()).rejects.toThrow('连接中断');
    const confirmed = await provision();
    expect(confirmed).toBe(books[0]?.id);
    expect(mock.post).toHaveBeenCalledTimes(2);
    expect(mock.post.mock.calls[0]?.[1]?.body.id).toBe(mock.post.mock.calls[1]?.[1]?.body.id);
  });

  it('私有本未知失败重试沿用完整变更包', async () => {
    mock.push.mockRejectedValueOnce(new TypeError('响应丢失'));
    const provision = createDefaultBookProvisioner('days', 'user');
    await expect(provision()).rejects.toThrow('响应丢失');
    await provision();
    expect(mock.push).toHaveBeenCalledTimes(2);
    expect(mock.push.mock.calls[0]?.[0]).toEqual(mock.push.mock.calls[1]?.[0]);
  });

  it('创建已确认但目录读取失败时只重读，不重建', async () => {
    const get = mock.get.getMockImplementation()!;
    let unreadable = true;
    mock.get.mockImplementation(async (path: string, options: unknown) => {
      if (path === paths.fitness && books.length > 0 && unreadable) throw new TypeError('目录断线');
      return get(path, options);
    });
    const provision = createDefaultBookProvisioner('fitness', 'user');
    await expect(provision()).rejects.toThrow('目录断线');
    unreadable = false;
    await provision();
    expect(mock.push).toHaveBeenCalledOnce();
  });

  it('只有归档账本时提示恢复，普通笔记不误用账号密码本', async () => {
    books = [{ id: 'archived', sync_id: 'sync', archived_at: '2026-01-01' }];
    await expect(createDefaultBookProvisioner('accounting', 'user')()).rejects.toThrow('现有账本都已归档');
    expect(mock.post).not.toHaveBeenCalled();
    books = [{ id: 'credentials', sync_id: 'sync', type: 'credentials' }];
    const normal = await createDefaultBookProvisioner('memos', 'user')();
    expect(normal).not.toBe('credentials');
    expect(mock.push.mock.calls[0]?.[0].payload).toMatchObject({ name: '默认备忘录', type: 'normal' });
  });

  it('账号密码入口复用专用本，不误用普通笔记本或新建同类容器', async () => {
    books = [
      { id: 'normal', sync_id: 'normal-sync', type: 'normal' },
      { id: 'credentials', sync_id: 'credential-sync', type: 'credentials' },
    ];
    await expect(createDefaultBookProvisioner('memos', 'user', 'credentials')()).resolves.toBe('credentials');
    expect(mock.push).not.toHaveBeenCalled();
    expect(mock.setQueryData).toHaveBeenCalledWith(keys.memos, { memo_books: books, server_cursor: '1' });
  });

  it('没有账号密码本时使用固定身份懒创建专用本，未知失败原包重试', async () => {
    books = [{ id: 'normal', sync_id: 'normal-sync', type: 'normal' }];
    mock.push.mockRejectedValueOnce(new TypeError('响应丢失'));
    const provision = createDefaultBookProvisioner('memos', 'user', 'credentials');
    await expect(provision()).rejects.toThrow('响应丢失');
    await provision();
    expect(mock.push.mock.calls[0]?.[0]).toEqual(mock.push.mock.calls[1]?.[0]);
    expect(mock.push.mock.calls[0]?.[0]).toMatchObject({
      entity_type: 'memo_book',
      base_revision: 0,
      payload: { name: '账号密码本', type: 'credentials' },
    });
    expect(mock.push.mock.calls[0]?.[0]).not.toHaveProperty('sync_id');
  });

  it('目录返回期间换号不发布旧缓存，重试也不能写入新账号', async () => {
    const get = mock.get.getMockImplementation()!;
    mock.get.mockImplementation(async (path: string, options: unknown) => {
      const result = await get(path, options);
      if (path === paths.days) mock.generation += 1;
      return result;
    });
    const provision = createDefaultBookProvisioner('days', 'user');
    await expect(provision()).rejects.toThrow('账号已切换');
    await expect(provision()).rejects.toThrow('账号已切换');
    expect(mock.push).not.toHaveBeenCalled();
    expect(mock.setQueryData).not.toHaveBeenCalled();
  });

  it('旧页面在换号后首次点击时拒绝账号不匹配', async () => {
    await expect(createDefaultBookProvisioner('days', 'previous-user')()).rejects.toThrow('账号已切换');
    expect(mock.push).not.toHaveBeenCalled();
    expect(mock.setQueryData).not.toHaveBeenCalled();
  });

  it('成功只使当前账号首页过期，先取消旧目录读取再发布权威缓存', async () => {
    await createDefaultBookProvisioner('days', 'user')();
    expect(mock.cancelQueries).toHaveBeenCalledWith({ queryKey: keys.days, exact: true });
    expect(mock.invalidateQueries).toHaveBeenCalledExactlyOnceWith({
      queryKey: ['account', 'user', 'overview'],
      exact: true,
      refetchType: 'none',
    });
    expect(mock.cancelQueries.mock.invocationCallOrder[0]).toBeLessThan(mock.setQueryData.mock.invocationCallOrder[0]!);
  });

  it('同账号域跨入口排队后重查目录，后到入口复用已创建本', async () => {
    let queue = Promise.resolve<unknown>(undefined);
    const request = vi.fn((_key: string, _options: unknown, work: () => Promise<string>) => {
      const result = queue.then(work);
      queue = result.catch(() => undefined);
      return result;
    });
    vi.stubGlobal('navigator', { locks: { request } });
    const first = createDefaultBookProvisioner('days', 'user');
    const second = createDefaultBookProvisioner('days', 'user');
    const ids = await Promise.all([first(), second()]);
    expect(ids[0]).toBe(ids[1]);
    expect(mock.push).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe('sesame-default-book:user:days');
  });

  it('普通笔记与账号密码共用备忘录锁，但分别复用自己的本子', async () => {
    books = [
      { id: 'normal', sync_id: 'normal-sync', type: 'normal' },
      { id: 'credentials', sync_id: 'credential-sync', type: 'credentials' },
    ];
    const request = vi.fn((_key: string, _options: unknown, work: () => Promise<string>) => work());
    vi.stubGlobal('navigator', { locks: { request } });
    await expect(createDefaultBookProvisioner('memos', 'user')()).resolves.toBe('normal');
    await expect(createDefaultBookProvisioner('memos', 'user', 'credentials')()).resolves.toBe('credentials');
    expect(request.mock.calls.map(([key]) => key)).toEqual([
      'sesame-default-book:user:memos',
      'sesame-default-book:user:memos',
    ]);
    expect(mock.push).not.toHaveBeenCalled();
  });
});
