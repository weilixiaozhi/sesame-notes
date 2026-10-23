import { accountingRequestFixturePath } from './accounting-request-fixture.js';
import { testStoragePath } from './test-storage-path.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { ApiError } from '../src/shared/errors.js';

const databaseUrl = testFixtureDatabaseUrl();
const config: ApiConfig = {
  databaseUrl,
  jwtSecret: 'cursor-test-secret-at-least-32-bytes-long',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2592000,
  storagePath: testStoragePath('sync-cursor'),
  exchangeRateUpstream: 'https://api.frankfurter.dev',
  exchangeRateCacheTtlSeconds: 43200,
  githubReleaseToken: '',
  port: 8080,
  host: '127.0.0.1',
  corsOrigins: [],
  rateLimitMax: 1000,
  authRateLimitMax: 1000,
  syncRetentionMinCursor: 0,
  trustProxyCidrs: [],
};
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = buildApp({ logger: false, config, prisma });

/** 用真实 HTTP 路由创建独立测试账号及设备。 */
async function registerUser() {
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        country_code: '+86',
        phone: `138${randomInt(100_000_000).toString().padStart(8, '0')}`,
        password: 'cursor-test-password',
        device: { installation_id: randomUUID(), name: 'cursor-test', platform: 'test' },
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ access_token: string; device_id: string; user: { user_id: string } }>();
  } catch (error) {
    console.error('同步游标测试账号创建失败', { error });
    throw error;
  }
}

beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe('同步游标的数据库范围', () => {
  it('超出 bigint 范围的数字返回输入错误，不进入事件查询', async () => {
    const owner = await registerUser();
    const findMany = vi.spyOn(prisma.syncChange, 'findMany');
    try {
      for (const since of ['9223372036854775808', '9999999999999999999', '9'.repeat(64)]) {
        const response = await app.inject({
          url: `/api/v1/sync/pull?since=${since}`,
          headers: { authorization: `Bearer ${owner.access_token}` },
        });
        expect(response.statusCode, response.body).toBe(400);
        expect(response.json()).toMatchObject({ code: 'INVALID_CURSOR' });
      }
      expect(findMany).not.toHaveBeenCalled();
    } catch (cause) {
      throw new Error('超范围同步游标验证失败', { cause });
    } finally {
      findMany.mockRestore();
    }
  });

  it('零游标交付注册默认目录，bigint 上界正常返回空分页', async () => {
    try {
      const owner = await registerUser();
      const initialEvents = await prisma.syncChange.findMany({
        where: { userId: owner.user.user_id },
        orderBy: { changeId: 'asc' },
      });
      expect(initialEvents).toHaveLength(61);
      for (const since of ['0', '9223372036854775807']) {
        const response = await app.inject({
          url: `/api/v1/sync/pull?since=${since}&limit=1000`,
          headers: { authorization: `Bearer ${owner.access_token}` },
        });
        expect(response.statusCode, response.body).toBe(200);
        if (since === '0') {
          const body = response.json<{
            changes: Array<{ change_id: string; entity_type: string; entity_id: string; action: string }>;
            server_cursor: string;
            has_more: boolean;
          }>();
          expect(body.changes.map((change) => change.change_id)).toEqual(
            initialEvents.map((event) => event.changeId.toString()),
          );
          expect(body.changes.map((change) => change.entity_id)).toEqual(initialEvents.map((event) => event.entityId));
          expect(body.changes.every((change) => change.entity_type === 'category' && change.action === 'upsert')).toBe(
            true,
          );
          expect(body.server_cursor).toBe(initialEvents.at(-1)!.changeId.toString());
          expect(body.has_more).toBe(false);
        } else {
          expect(response.json()).toEqual({ changes: [], server_cursor: since, has_more: false });
        }
      }
    } catch (cause) {
      throw new Error('有效同步游标边界验证失败', { cause });
    }
  });
});

describe('同步写事务的连接占用', () => {
  it.each(['REST', 'imports'])('%s 在单连接池中完成幂等首写与重放', async (writer) => {
    const owner = await registerUser();
    const headers = { authorization: `Bearer ${owner.access_token}`, 'idempotency-key': randomUUID() };
    const ledgerId = randomUUID();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/ledgers',
      headers,
      payload: { id: ledgerId, name: '单连接事务' },
    });
    expect(created.statusCode).toBe(201);
    const limitedUrl = new URL(databaseUrl);
    limitedUrl.searchParams.set('connection_limit', '1');
    limitedUrl.searchParams.set('pool_timeout', '1');
    const limitedApp = buildApp({
      logger: false,
      config,
      prisma: new PrismaClient({ datasourceUrl: limitedUrl.toString() }),
    });
    const transaction = {
      id: randomUUID(),
      tx_type: 'expense',
      amount: '1',
      native_amount: '1',
      currency_code: 'CNY',
      happened_at: '2026-09-06T00:00:00.000Z',
    };
    try {
      await limitedApp.ready();
      const request = {
        method: 'POST' as const,
        url: await accountingRequestFixturePath(
          app,
          'POST',
          `/api/v1/ledgers/${ledgerId}/${writer === 'REST' ? 'transactions' : 'imports'}`,
          headers,
        ),
        headers,
        payload: writer === 'REST' ? transaction : { transactions: [transaction] },
      };
      const first = await limitedApp.inject(request);
      expect(first.statusCode).toBe(201);
      const repeated = await limitedApp.inject(request);
      expect(repeated.statusCode).toBe(200);
      expect(repeated.json()).toEqual(first.json());
      expect(await prisma.syncChange.count({ where: { entityId: transaction.id } })).toBe(1);
    } catch (error) {
      console.error('单连接同步事务验证失败', { writer, ledgerId, error });
      throw error;
    } finally {
      await limitedApp.close();
    }
  });
});

describe('已提交事件的增量交付', () => {
  it.each([
    { writer: 'REST', full: false, rollback: false },
    { writer: 'push', full: false, rollback: false },
    { writer: 'imports', full: false, rollback: false },
    { writer: 'push', full: true, rollback: false },
    { writer: 'imports', full: false, rollback: true },
  ])(
    '$writer 与迟提交事务交错：full=$full，rollback=$rollback',
    async ({ writer, full, rollback }) => {
      const owner = await registerUser();
      const editor = await registerUser();
      const ownerHeaders = { authorization: `Bearer ${owner.access_token}` };
      const editorHeaders = { authorization: `Bearer ${editor.access_token}` };
      const ledgerA = randomUUID();
      const ledgerB = randomUUID();
      let syncId = '';
      for (const id of [ledgerA, ledgerB]) {
        const created = await app.inject({
          method: 'POST',
          url: '/api/v1/ledgers',
          headers: ownerHeaders,
          payload: { id, name: '游标测试' },
        });
        expect(created.statusCode).toBe(201);
        syncId = created.json<{ sync_id: string }>().sync_id;
        const invite = await app.inject({
          method: 'POST',
          url: `/api/v1/ledgers/${id}/invites`,
          headers: ownerHeaders,
          payload: {},
        });
        expect(invite.statusCode).toBe(201);
        const accepted = await app.inject({
          method: 'POST',
          url: `/api/v1/invites/${invite.json<{ code: string }>().code}/accept`,
          headers: editorHeaders,
          payload: {},
        });
        expect(accepted.statusCode).toBe(200);
      }
      const initial = await app.inject({ url: '/api/v1/sync/pull?since=0&limit=1000', headers: editorHeaders });
      expect(initial.statusCode).toBe(200);
      const baseline = initial.json<{ server_cursor: string }>().server_cursor;
      const allocated = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let delayedChangeId = 0n;
      // 只延迟真实 INSERT 返回后的事务提交，不替换数据库读写或路由实现。
      const delayedPrisma = new PrismaClient({ datasourceUrl: databaseUrl }).$extends({
        query: {
          syncChange: {
            async create({ args, query }) {
              try {
                const event = await query(args);
                if (event.changeId === undefined) throw new Error('事件 INSERT 未返回同步序号');
                delayedChangeId = event.changeId;
                allocated.resolve();
                await release.promise;
                if (rollback) throw new ApiError(400, 'TEST_ROLLBACK', '测试事务回滚');
                return event;
              } catch (error) {
                allocated.reject(error);
                throw error;
              }
            },
          },
        },
      });
      const delayedApp = buildApp({ logger: false, config, prisma: delayedPrisma as unknown as PrismaClient });
      const applicationName = `cursor-${randomUUID()}`;
      const competingUrl = new URL(databaseUrl);
      competingUrl.searchParams.set('application_name', applicationName);
      const competingApp = buildApp({
        logger: false,
        config,
        prisma: new PrismaClient({ datasourceUrl: competingUrl.toString() }),
      });
      let first: Promise<{ statusCode: number }> | undefined;
      let second: Promise<{ statusCode: number }> | undefined;
      try {
        await Promise.all([delayedApp.ready(), competingApp.ready()]);
        first = delayedApp
          .inject({
            method: 'PATCH',
            url: `/api/v1/ledgers/${ledgerA}`,
            headers: ownerHeaders,
            payload: { name: '迟提交' },
          })
          .then((response) => response);
        await Promise.race([
          allocated.promise,
          first.then(() => {
            throw new Error('事务未到达事件提交屏障');
          }),
        ]);
        const transactionIds = [randomUUID(), randomUUID()];
        if (writer === 'REST') {
          second = competingApp
            .inject({
              method: 'PATCH',
              url: `/api/v1/ledgers/${ledgerB}`,
              headers: ownerHeaders,
              payload: { name: '交错写入' },
            })
            .then((response) => response);
        } else if (writer === 'push') {
          second = competingApp
            .inject({
              method: 'POST',
              url: '/api/v1/sync/push',
              headers: ownerHeaders,
              payload: {
                device_id: owner.device_id,
                changes: [
                  {
                    mutation_id: randomUUID(),
                    entity_type: 'ledger',
                    entity_id: ledgerB,
                    ledger_id: ledgerB,
                    sync_id: syncId,
                    action: 'upsert',
                    updated_at: new Date(Date.now() + 1000).toISOString(),
                    payload: { name: '交错写入', currency: 'CNY', month_start_day: 1, aa_enabled: false },
                  },
                ],
              },
            })
            .then((response) => response);
        } else {
          // Editor 在另一设备导入两笔交易，同一事务的全部事件都必须可交付。
          second = competingApp
            .inject({
              method: 'POST',
              url: await accountingRequestFixturePath(app, 'POST', `/api/v1/ledgers/${ledgerB}/imports`, editorHeaders),
              headers: editorHeaders,
              payload: {
                transactions: transactionIds.map((id) => ({
                  id,
                  tx_type: 'expense',
                  amount: '1',
                  native_amount: '1',
                  currency_code: 'CNY',
                  happened_at: '2026-09-06T00:00:00.000Z',
                })),
              },
            })
            .then((response) => response);
        }
        let secondFinished = false;
        void second.finally(() => {
          secondFinished = true;
        });
        // 等到第二个事务确实完成或在数据库等待锁，避免靠固定延迟猜测并发时序。
        await expect
          .poll(
            async () => {
              const waiting = await prisma.$queryRaw<
                Array<{ waiting: boolean }>
              >`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = ${applicationName} AND wait_event_type = 'Lock') AS waiting`;
              return secondFinished || waiting[0]?.waiting === true;
            },
            { timeout: 3000 },
          )
          .toBe(true);
        const before = await app.inject({
          url: full ? `/api/v1/sync/full?ledger_id=${ledgerB}` : `/api/v1/sync/pull?since=${baseline}&limit=1000`,
          headers: editorHeaders,
        });
        expect(before.statusCode).toBe(200);
        const cursor = before.json<{ server_cursor: string }>().server_cursor;
        release.resolve();
        const [firstResponse, secondResponse] = await Promise.all([first, second]);
        expect(firstResponse.statusCode).toBe(rollback ? 500 : 200);
        expect(secondResponse.statusCode).toBe(writer === 'imports' ? 201 : 200);
        const after = await app.inject({ url: `/api/v1/sync/pull?since=${cursor}&limit=1000`, headers: editorHeaders });
        expect(after.statusCode).toBe(200);
        const delivered = after
          .json<{ changes: Array<{ change_id: string }> }>()
          .changes.map((change) => change.change_id);
        if (rollback) {
          expect(await prisma.syncChange.findUnique({ where: { changeId: delayedChangeId } })).toBeNull();
          expect((await prisma.ledger.findUniqueOrThrow({ where: { id: ledgerA } })).name).toBe('游标测试');
        } else {
          // 需求锚点：上次响应之后才提交且始终可见的事件，按返回游标继续拉取必须收到。
          expect(delivered).toContain(delayedChangeId.toString());
        }
        const persisted = await prisma.syncChange.findMany({
          where: { ledgerId: ledgerB, changeId: { gt: BigInt(cursor) } },
        });
        expect(delivered).toEqual(expect.arrayContaining(persisted.map((event) => event.changeId.toString())));
        if (writer === 'imports')
          expect(await prisma.syncChange.count({ where: { entityId: { in: transactionIds } } })).toBe(2);
        const repeated = await app.inject({
          url: `/api/v1/sync/pull?since=${cursor}&limit=1000`,
          headers: editorHeaders,
        });
        expect(repeated.json()).toEqual(after.json());
      } catch (error) {
        console.error('并发游标交付验证失败', { writer, full, rollback, ledgerA, ledgerB, error });
        throw error;
      } finally {
        release.resolve();
        await Promise.allSettled([first, second]);
        await Promise.all([delayedApp.close(), competingApp.close()]);
      }
    },
    20000,
  );
});
