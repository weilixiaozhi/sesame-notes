import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { requireSyncCutover } from '../src/shared/sync-cutover.js';
import { fullSnapshotCursor, latestVisibleCursor } from '../src/modules/sync/testing.js';
import type { ApiConfig } from '../src/shared/api-config.js';
import { assertSyncSnapshot } from '../src/shared/sync-mutation.js';
import type { SyncTransaction } from '../src/shared/sync-transaction.js';

/** 模拟当前同步切点、持久下界与事件水位，验证读取和条件写入共用同一边界。 */
function repository() {
  try {
    const state = { cursor: null as bigint | null, completedAt: null as Date | null, cursorFloor: 0n, observed: 0n };
    const db = {
      $queryRaw: vi.fn(async () => [
        { cursor: state.cursor, completedAt: state.completedAt, cursorFloor: state.cursorFloor },
      ]),
      syncChange: {
        aggregate: vi.fn(async () => ({ _max: { changeId: state.observed || null } })),
        findFirst: vi.fn(async (): Promise<{ changeId: bigint } | null> => null),
      },
    };
    return { state, db, prisma: db as unknown as PrismaClient };
  } catch (cause) {
    throw new Error('当前同步水位测试夹具创建失败', { cause });
  }
}

describe('当前同步协议的持久水位', () => {
  it('切点前拒绝同步；历史事件清空后full及push水位仍不低于原切点', async () => {
    const fixture = repository();
    await expect(requireSyncCutover(fixture.prisma)).rejects.toMatchObject({
      code: 'SYNC_PROTOCOL_MIGRATION_REQUIRED',
    });
    fixture.state.cursor = 42n;
    fixture.state.completedAt = new Date(0);
    fixture.state.observed = 0n;
    expect(await fullSnapshotCursor(fixture.prisma, { syncRetentionMinCursor: 0 } as ApiConfig)).toBe(42n);
    expect(await latestVisibleCursor(fixture.prisma, 'user')).toBe(42n);
    await expect(fullSnapshotCursor(fixture.prisma, { syncRetentionMinCursor: 43 } as ApiConfig)).rejects.toMatchObject(
      {
        code: 'SYNC_RETENTION_INVALID',
      },
    );
  });

  it('条件写入接受完整快照的持久切点，同时拒绝未来游标和预览后的变更', async () => {
    try {
      const fixture = repository();
      fixture.state.cursor = 42n;
      fixture.state.completedAt = new Date(0);
      fixture.state.observed = 0n;
      const tx = fixture.prisma as unknown as SyncTransaction;
      const scope = { memoBookId: '11111111-1111-4111-8111-111111111111' };
      const cursor = await fullSnapshotCursor(tx, { syncRetentionMinCursor: 0 } as ApiConfig);
      await expect(assertSyncSnapshot(tx, scope, cursor.toString(), 0n)).resolves.toBeUndefined();
      await expect(assertSyncSnapshot(tx, scope, '43', 0n)).rejects.toMatchObject({ code: 'SYNC_SNAPSHOT_CHANGED' });
      await expect(assertSyncSnapshot(tx, scope, '42', 43n)).rejects.toMatchObject({ code: 'SYNC_SNAPSHOT_CHANGED' });
      fixture.state.observed = 60n;
      fixture.db.syncChange.findFirst.mockResolvedValueOnce({ changeId: 60n });
      await expect(assertSyncSnapshot(tx, scope, '42', 0n)).rejects.toMatchObject({ code: 'SYNC_SNAPSHOT_CHANGED' });
      expect(fixture.db.syncChange.findFirst).toHaveBeenLastCalledWith({
        where: { ...scope, changeId: { gt: 42n } },
        select: { changeId: true },
      });
    } catch (cause) {
      throw new Error('完整快照与条件写入的水位一致性验证失败', { cause });
    }
  });

  it('清理保存的水位高于当前事件时仍有效，一次性协议切点保持原值', async () => {
    try {
      const fixture = repository();
      fixture.state.cursor = 42n;
      fixture.state.completedAt = new Date(0);
      fixture.state.cursorFloor = 70n;
      fixture.state.observed = 60n;
      expect(await requireSyncCutover(fixture.prisma)).toBe(42n);
      expect(await fullSnapshotCursor(fixture.prisma, { syncRetentionMinCursor: 0 } as ApiConfig)).toBe(70n);
      const tx = fixture.prisma as unknown as SyncTransaction;
      await expect(assertSyncSnapshot(tx, { memoBookId: 'book' }, '70', 0n)).resolves.toBeUndefined();
      await expect(assertSyncSnapshot(tx, { memoBookId: 'book' }, '71', 0n)).rejects.toMatchObject({
        code: 'SYNC_SNAPSHOT_CHANGED',
      });
      await expect(assertSyncSnapshot(tx, { memoBookId: 'book' }, '70', 71n)).rejects.toMatchObject({
        code: 'SYNC_SNAPSHOT_CHANGED',
      });
    } catch (cause) {
      throw new Error('清理持久水位与协议切点边界验证失败', { cause });
    }
  });
});
