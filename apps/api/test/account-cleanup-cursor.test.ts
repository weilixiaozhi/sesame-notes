import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../src/shared/api-config.js';
import { assertSyncSnapshot } from '../src/shared/sync-mutation.js';
import type { SyncTransaction } from '../src/shared/sync-transaction.js';
import { deleteAccount } from '../src/modules/accounts/index.js';
import { fullSnapshotCursor } from '../src/modules/sync/testing.js';

/** 严格模拟账号清理涉及的表和事务回滚，未知 SQL 直接失败。 */
function repository() {
  const state = {
    floor: 0n,
    cutover: 42n,
    events: [
      { userId: 'remaining-user', ledgerId: null, changeId: 41n },
      { userId: 'deleting-user', ledgerId: null, changeId: 60n },
    ],
  };
  const operations: string[] = [];
  const tx = {
    $executeRaw: vi.fn(async (query: TemplateStringsArray) => {
      const sql = query.join('');
      if (sql.includes('pg_advisory_xact_lock')) {
        operations.push('lock');
        return 1;
      }
      if (sql.includes('UPDATE server_epochs') && sql.includes('sync_cursor_floor = GREATEST(')) {
        operations.push('preserve');
        state.floor = state.events.reduce(
          (maximum, event) => (event.changeId > maximum ? event.changeId : maximum),
          state.floor > state.cutover ? state.floor : state.cutover,
        );
        return 1;
      }
      throw new Error(`未声明的测试写入：${sql}`);
    }),
    $queryRaw: vi.fn(async (query: TemplateStringsArray) => {
      const sql = query.join('');
      if (sql.includes('server_epochs'))
        return [{ cursor: state.cutover, completedAt: new Date(0), cursorFloor: state.floor }];
      if (sql.includes('SELECT id FROM users')) return [{ id: 'deleting-user' }];
      throw new Error(`未声明的测试查询：${sql}`);
    }),
    ledger: { findFirst: async () => null, findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    device: { findFirst: async () => ({ id: 'device' }) },
    ledgerMember: { findMany: async () => [] },
    user: { delete: vi.fn(async () => ({})) },
    syncChange: {
      aggregate: async () => ({
        _max: {
          changeId: state.events.reduce((maximum, event) => (event.changeId > maximum ? event.changeId : maximum), 0n),
        },
      }),
      findFirst: async () => null,
      deleteMany: vi.fn(async ({ where }: { where: { OR: Array<{ userId?: string }> } }) => {
        operations.push('delete');
        const previous = state.events.length;
        state.events = state.events.filter((event) => event.userId !== where.OR[0]!.userId);
        return { count: previous - state.events.length };
      }),
    },
  };
  const prisma = {
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => {
      const before = { floor: state.floor, events: [...state.events] };
      try {
        return await operation(tx);
      } catch (cause) {
        Object.assign(state, before);
        throw cause;
      }
    },
  };
  return { state, operations, tx, prisma: prisma as unknown as PrismaClient, client: tx as unknown as SyncTransaction };
}

describe('账号事件清理的持久全局水位', () => {
  it('注销另一纯私有账号不会使已下载的完整游标倒退，条件操作仍可使用该游标', async () => {
    try {
      const fixture = repository();
      const config = { syncRetentionMinCursor: 0 } as ApiConfig;
      const before = await fullSnapshotCursor(fixture.client, config);
      expect(before).toBe(60n);
      await deleteAccount(fixture.prisma, 'deleting-user');
      expect(fixture.operations).toEqual(['lock', 'preserve', 'delete']);
      expect(fixture.state.events).toEqual([{ userId: 'remaining-user', ledgerId: null, changeId: 41n }]);
      expect(fixture.state.cutover).toBe(42n);
      expect(await fullSnapshotCursor(fixture.client, config)).toBe(before);
      await expect(
        assertSyncSnapshot(fixture.client, { fitnessSpaceId: 'remaining-space' }, '60', 0n),
      ).resolves.toBeUndefined();
      await expect(
        assertSyncSnapshot(fixture.client, { fitnessSpaceId: 'remaining-space' }, '61', 0n),
      ).rejects.toMatchObject({ code: 'SYNC_SNAPSHOT_CHANGED' });
    } catch (cause) {
      throw new Error('账号注销后的完整快照水位验证失败', { cause });
    }
  });

  it('后续清理没有更大事件时保留已有下界', async () => {
    try {
      const fixture = repository();
      fixture.state.floor = 90n;
      await deleteAccount(fixture.prisma, 'deleting-user');
      expect(fixture.state.floor).toBe(90n);
      expect(await fullSnapshotCursor(fixture.client, { syncRetentionMinCursor: 0 } as ApiConfig)).toBe(90n);
    } catch (cause) {
      throw new Error('重复清理的水位保留验证失败', { cause });
    }
  });

  it.each(['missing', 'failure'] as const)('持久水位保存%s时禁止删除事件或账号', async (scenario) => {
    try {
      const fixture = repository();
      const execute = fixture.tx.$executeRaw.getMockImplementation()!;
      fixture.tx.$executeRaw.mockImplementation(async (query) => {
        if (query.join('').includes('UPDATE server_epochs')) {
          if (scenario === 'missing') return 0;
          throw new Error('floor unavailable');
        }
        return execute(query);
      });
      await expect(deleteAccount(fixture.prisma, 'deleting-user')).rejects.toThrow('账号删除事务失败');
      expect(fixture.tx.syncChange.deleteMany).not.toHaveBeenCalled();
      expect(fixture.tx.user.delete).not.toHaveBeenCalled();
      expect(fixture.state.floor).toBe(0n);
      expect(fixture.state.events).toHaveLength(2);
    } catch (cause) {
      throw new Error('水位保存失败的清理保护验证失败', { cause });
    }
  });

  it('事件删除失败时同一事务回滚持久下界', async () => {
    try {
      const fixture = repository();
      fixture.tx.syncChange.deleteMany.mockRejectedValue(new Error('delete unavailable'));
      await expect(deleteAccount(fixture.prisma, 'deleting-user')).rejects.toThrow('账号删除事务失败');
      expect(fixture.operations).toEqual(['lock', 'preserve']);
      expect(fixture.state.floor).toBe(0n);
      expect(fixture.state.events).toHaveLength(2);
      expect(fixture.tx.user.delete).not.toHaveBeenCalled();
    } catch (cause) {
      throw new Error('事件删除失败的水位事务回滚验证失败', { cause });
    }
  });
});
