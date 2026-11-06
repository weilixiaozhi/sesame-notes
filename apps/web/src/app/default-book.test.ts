import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@sesame-notes/api-client';
import { createDefaultBookProvisioner as createProvisioner, type DefaultBookKind } from './default-book';
import { createLedgerSubmitter } from '../features/accounting/entity-submit';

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

/** 各入口提供其领域能力，测试继续通过真实账本保存器验证未知结果恢复。 */
function createDefaultBookProvisioner(
  kind: DefaultBookKind,
  accountId: string,
  memoType: 'normal' | 'credentials' = 'normal',
) {
  if (kind === 'accounting') return createProvisioner(kind, accountId, createLedgerSubmitter);
  if (kind === 'memos') return createProvisioner(kind, accountId, memoType);
  return createProvisioner(kind, accountId);
}

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
});
