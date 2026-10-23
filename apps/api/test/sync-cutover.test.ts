import type { Prisma, PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  assertDatabaseUpgradeTarget,
  completeSyncProtocolUpgrade,
  databaseUpgradeDatasourceUrl,
} from '../prisma/sync-protocol-upgrade.mjs';
import { requireSyncCutover } from '../src/shared/sync-cutover.js';
import { fullSnapshotCursor, latestVisibleCursor } from '../src/modules/sync/testing.js';
import type { ApiConfig } from '../src/shared/api-config.js';
import { assertSyncSnapshot } from '../src/shared/sync-mutation.js';
import type { SyncTransaction } from '../src/shared/sync-transaction.js';

const databaseUrl = 'postgresql://sesame:private-value@127.0.0.1:5400/sesame_test_cutover?schema=public';

/** 内存替身限制数据库读写范围，并模拟事务回滚以验证失败不留下半完成状态。 */
function repository() {
  const state = {
    database: 'sesame_test_cutover',
    schema: 'public',
    username: 'sesame',
    installed: true,
    initialized: true,
    singleton: true,
    cursor: null as bigint | null,
    cursorFloor: 0n,
    completedAt: null as Date | null,
    observed: 42n,
    clients: 0n,
    audit: [] as Array<{ target: unknown; metadata: unknown }>,
  };
  const operations: string[] = [];
  const db = {
    $queryRaw: vi.fn(async (query: TemplateStringsArray) => {
      const sql = query.join('');
      if (sql.includes('current_schema()'))
        return [{ database: state.database, schema: state.schema, username: state.username }];
      if (sql.includes('information_schema.columns'))
        return [{ installed: state.installed, initialized: state.initialized }];
      if (sql.includes('pg_stat_activity')) {
        operations.push('connections');
        return [{ clients: state.clients }];
      }
      if (sql.includes('server_epochs'))
        return state.singleton
          ? [
              {
                cursor: state.cursor,
                completed_at: state.completedAt,
                completedAt: state.completedAt,
                cursorFloor: state.cursorFloor,
              },
            ]
          : [];
      if (sql.includes('MAX(change_id)')) {
        operations.push('watermark');
        return [{ cursor: state.observed }];
      }
      throw new Error(`未声明的测试查询：${sql}`);
    }),
    $executeRaw: vi.fn(async (query: TemplateStringsArray, ...values: unknown[]) => {
      const sql = query.join('');
      if (sql.includes('UPDATE public.server_epochs')) {
        operations.push('cutover');
        state.cursor = values[0] as bigint;
        state.completedAt = values[1] as Date;
        return 1;
      }
      if (sql.includes('INSERT INTO public.audit_logs')) {
        operations.push('audit');
        state.audit.push({ target: JSON.parse(values[0] as string), metadata: JSON.parse(values[1] as string) });
        return 1;
      }
      if (sql.includes('pg_advisory_xact_lock')) operations.push('advisory-lock');
      else if (sql.includes('LOCK TABLE')) operations.push('table-lock');
      else if (!sql.includes('set_config')) throw new Error(`未声明的测试写入：${sql}`);
      return 0;
    }),
    syncChange: {
      aggregate: vi.fn(async () => ({ _max: { changeId: state.observed || null } })),
      findFirst: vi.fn(async (): Promise<{ changeId: bigint } | null> => null),
    },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (operation: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
    const before = { cursor: state.cursor, completedAt: state.completedAt, audit: [...state.audit] };
    try {
      return await operation(db as unknown as Prisma.TransactionClient);
    } catch (error) {
      Object.assign(state, before);
      throw error;
    }
  });
  return { state, operations, db, prisma: db as unknown as PrismaClient };
}

describe('数据库自动完成一次性同步协议升级', () => {
  it('停写事务保存原始水位与真实自动审计，重复部署不推进切点', async () => {
    const fixture = repository();
    expect(await completeSyncProtocolUpgrade(fixture.prisma, databaseUrl)).toMatchObject({
      applied: true,
      original_cursor: '42',
    });
    expect(fixture.operations).toEqual([
      'connections',
      'advisory-lock',
      'table-lock',
      'connections',
      'watermark',
      'cutover',
      'audit',
      'connections',
    ]);
    expect(fixture.state.audit).toEqual([
      {
        target: { type: 'database', id: 'sesame_test_cutover' },
        metadata: expect.objectContaining({
          mode: 'automatic_upgrade',
          source: 'db-init',
          original_cursor: '42',
          result_cursor: '42',
        }),
      },
    ]);
    const saved = fixture.state.completedAt;
    fixture.state.observed = 100n;
    fixture.state.clients = 2n;
    fixture.db.$executeRaw.mockClear();
    expect(await completeSyncProtocolUpgrade(fixture.prisma, databaseUrl)).toMatchObject({
      applied: false,
      original_cursor: '42',
      completed_at: saved!.toISOString(),
    });
    expect(fixture.state.audit).toHaveLength(1);
    expect(fixture.db.$executeRaw).not.toHaveBeenCalled();
  });

  it('空库迁移已设置的零切点保持不变，不生成重复审计', async () => {
    const fixture = repository();
    fixture.state.cursor = 0n;
    fixture.state.completedAt = new Date(0);
    fixture.state.clients = 1n;
    expect(await completeSyncProtocolUpgrade(fixture.prisma, databaseUrl)).toMatchObject({
      applied: false,
      original_cursor: '0',
      completed_at: new Date(0).toISOString(),
    });
    expect(fixture.db.$executeRaw).not.toHaveBeenCalled();
    expect(fixture.state.audit).toEqual([]);
  });

  it('部署前目标核验只读并接受显式单连接配置', async () => {
    const fixture = repository();
    expect(await assertDatabaseUpgradeTarget(fixture.prisma, `${databaseUrl}&connection_limit=1`)).toEqual({
      database: 'sesame_test_cutover',
      username: 'sesame',
      target: '127.0.0.1:5400/sesame_test_cutover',
    });
    expect(fixture.db.$executeRaw).not.toHaveBeenCalled();
    expect(fixture.db.$transaction).not.toHaveBeenCalled();
  });

  it('沿用生产模板连接池及TLS设置，仅把维护连接池规范为单连接', async () => {
    const fixture = repository();
    const configured = `${databaseUrl}&connection_limit=10&pool_timeout=20&connect_timeout=30&sslmode=require&sslcert=server.pem`;
    const normalized = new URL(databaseUpgradeDatasourceUrl(configured));
    expect(normalized.searchParams.get('connection_limit')).toBe('1');
    expect(normalized.searchParams.get('pool_timeout')).toBe('20');
    expect(normalized.searchParams.get('connect_timeout')).toBe('30');
    expect(normalized.searchParams.get('sslmode')).toBe('require');
    expect(normalized.searchParams.get('sslcert')).toBe('server.pem');
    expect(await completeSyncProtocolUpgrade(fixture.prisma, configured)).toMatchObject({
      applied: true,
      original_cursor: '42',
    });
  });

  it('管理库、其他schema与不匹配的实际身份都在写入前拒绝', async () => {
    for (const url of [
      databaseUrl.replace('sesame_test_cutover', 'postgres'),
      databaseUrl.replace('public', 'private'),
      `${databaseUrl}&options=unsafe`,
      `${databaseUrl}&schema=public`,
    ]) {
      const fixture = repository();
      await expect(completeSyncProtocolUpgrade(fixture.prisma, url)).rejects.toMatchObject({
        cause: expect.objectContaining({ message: '同步协议升级数据库配置无效' }),
      });
      expect(fixture.db.$transaction).not.toHaveBeenCalled();
    }
    for (const field of ['database', 'schema', 'username'] as const) {
      const fixture = repository();
      fixture.state[field] = 'unexpected';
      await expect(completeSyncProtocolUpgrade(fixture.prisma, databaseUrl)).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: '数据库升级目标身份核验失败',
          cause: expect.objectContaining({ message: '实际数据库、schema 或连接账号与部署目标不一致' }),
        }),
      });
      expect(fixture.db.$executeRaw).not.toHaveBeenCalled();
    }
  });

  it('结构未完成、单例缺失或切点损坏时不猜测恢复状态', async () => {
    for (const patch of [
      { installed: false },
      { initialized: false },
      { singleton: false },
      { cursor: 42n },
      { completedAt: new Date(0) },
      { cursor: -1n, completedAt: new Date(0) },
    ]) {
      const fixture = repository();
      Object.assign(fixture.state, patch);
      await expect(completeSyncProtocolUpgrade(fixture.prisma, databaseUrl)).rejects.toThrow('同步协议自动升级未完成');
      expect(fixture.db.$executeRaw).not.toHaveBeenCalled();
    }
  });

  it('外部连接在开始或审计后出现均阻止完成，晚出现时整体回滚', async () => {
    for (const late of [false, true]) {
      const fixture = repository();
      if (late) {
        const original = fixture.db.$executeRaw.getMockImplementation()!;
        fixture.db.$executeRaw.mockImplementation(async (query, ...values) => {
          const result = await original(query, ...values);
          if (query.join('').includes('INSERT INTO public.audit_logs')) fixture.state.clients = 1n;
          return result;
        });
      } else fixture.state.clients = 1n;
      await expect(completeSyncProtocolUpgrade(fixture.prisma, databaseUrl)).rejects.toMatchObject({
        cause: expect.objectContaining({ message: '同步协议自动升级需要独占停写窗口' }),
      });
      expect(fixture.state.cursor).toBeNull();
      expect(fixture.state.completedAt).toBeNull();
      expect(fixture.state.audit).toEqual([]);
    }
  });

  it('审计写入失败保留详细原因并回滚切点', async () => {
    const fixture = repository();
    const cause = new Error('audit unavailable');
    const original = fixture.db.$executeRaw.getMockImplementation()!;
    fixture.db.$executeRaw.mockImplementation(async (query, ...values) => {
      if (query.join('').includes('INSERT INTO public.audit_logs')) throw cause;
      return original(query, ...values);
    });
    await expect(completeSyncProtocolUpgrade(fixture.prisma, databaseUrl)).rejects.toMatchObject({ cause });
    expect(fixture.state.cursor).toBeNull();
    expect(fixture.state.completedAt).toBeNull();
    expect(fixture.state.audit).toEqual([]);
  });

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
