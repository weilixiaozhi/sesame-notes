import { testStoragePath } from './test-storage-path.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';

import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';

const DATABASE_URL = testFixtureDatabaseUrl();
const API_BASE = '/api/v1';

const config: ApiConfig = {
  databaseUrl: DATABASE_URL,
  jwtSecret: 'e2e-test-secret-that-is-at-least-32-bytes-long',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  storagePath: testStoragePath('revision'),
  exchangeRateUpstream: 'https://api.frankfurter.dev',
  exchangeRateCacheTtlSeconds: 43_200,
  githubReleaseToken: '',
  port: 8080,
  host: '127.0.0.1',
  corsOrigins: [],
  rateLimitMax: 1000,
  authRateLimitMax: 1000,
  syncRetentionMinCursor: 0,
  trustProxyCidrs: [],
};

let prisma: PrismaClient;
let app: ReturnType<typeof buildApp>;

function uuid(): string {
  return randomUUID();
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function api(
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  body?: Record<string, unknown>,
  token?: string,
) {
  const response = await app.inject({
    method,
    url: `${API_BASE}${path}`,
    payload: body,
    headers: {
      ...(token ? bearer(token) : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
  });
  return {
    status: response.statusCode,
    json: (): unknown => (response.body ? JSON.parse(response.body) : null),
    body: response.body,
  };
}

/** 生成每次调用唯一且可登录的手机号（+86 区号，11 位） */
function uniquePhone(): string {
  return `138${randomUUID().replace(/\D/g, '').slice(0, 8)}`;
}

/** 注册版本冲突测试账号，返回真实会话和实体身份。 */
async function registerUser(): Promise<{ token: string; deviceId: string; userId: string }> {
  const res = await api('post', '/auth/register', {
    country_code: '+86',
    phone: uniquePhone(),
    password: 'password-123456',
    device: { installation_id: uuid(), name: 'e2e-device', platform: 'e2e' },
  });
  expect(res.status).toBe(201);
  const session = res.json() as { access_token: string; device_id: string; user: { user_id: string } };
  return { token: session.access_token, deviceId: session.device_id, userId: session.user.user_id };
}

/** 构造交易 push 请求；baseRevision 缺省表示创建（expected absent）。 */
function txPush(
  deviceId: string,
  ledgerId: string,
  syncId: string,
  txnId: string,
  opts: {
    baseRevision?: number;
    note?: string;
    action?: 'upsert' | 'delete';
    mutationId?: string;
    aaMode?: '0' | '1' | '2' | null;
    splits?: Array<{ member_id: string; amount: string }>;
  } = {},
) {
  const mutationId = opts.mutationId ?? uuid();
  const baseChange = {
    mutation_id: mutationId,
    entity_type: 'transaction',
    entity_id: txnId,
    ledger_id: ledgerId,
    sync_id: syncId,
    action: opts.action ?? ('upsert' as const),
    updated_at: '2026-08-22T11:00:00.000Z',
  };
  const change =
    opts.action === 'delete'
      ? { ...baseChange, ...(opts.baseRevision === undefined ? {} : { base_revision: opts.baseRevision }), payload: {} }
      : {
          ...baseChange,
          ...(opts.baseRevision === undefined ? {} : { base_revision: opts.baseRevision }),
          payload: {
            tx_type: 'expense',
            amount: '20',
            happened_at: '2026-08-22T11:00:00.000Z',
            note: opts.note ?? '同步交易',
            category_id: null,
            currency_code: 'CNY',
            native_amount: '20',
            recurring_id: null,
            aa_mode: opts.aaMode ?? null,
            splits: opts.splits ?? [],
            last_edited_at: null,
          },
        };
  return { device_id: deviceId, changes: [change] };
}

/** 一次性建好账本与同步身份，返回绑定后的 (token, deviceId, syncId)。 */
async function setupCloudLedger(): Promise<{ token: string; deviceId: string; syncId: string; ledgerId: string }> {
  const { token, deviceId } = await registerUser();
  const ledgerId = uuid();
  // 创建账本并取得同步身份
  const ledgerPush = await api(
    'post',
    '/sync/push',
    {
      device_id: deviceId,
      changes: [
        {
          mutation_id: uuid(),
          entity_type: 'ledger',
          entity_id: ledgerId,
          ledger_id: ledgerId,
          action: 'upsert',
          updated_at: '2026-08-22T11:00:00.000Z',
          payload: { name: 'revision 账本', currency: 'CNY', month_start_day: 1, aa_enabled: false },
        },
      ],
    },
    token,
  );
  expect(ledgerPush.status).toBe(200);
  const ledgerBody = ledgerPush.json() as { outcomes: Array<{ sync_id?: string }> };
  return { token, deviceId, syncId: ledgerBody.outcomes[0]!.sync_id!, ledgerId };
}

type PushOutcome = {
  mutation_id?: string;
  entity_id: string;
  status: string;
  change_id: string | null;
  revision?: number;
  current_revision?: number;
  current_deleted?: boolean;
  current_entity?: unknown;
};

beforeAll(async () => {
  prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
  app = buildApp({ logger: false, config, prisma });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('Transaction revision 状态机', () => {
  it.each(['事件', '唯一约束'] as const)('同步%s故障回滚并记录根因，整批重试不重复提交', async (stage) => {
    const { token, deviceId, syncId, ledgerId } = await setupCloudLedger();
    const ids = [uuid(), uuid(), uuid()];
    const changes = ids.map((id) => txPush(deviceId, ledgerId, syncId, id).changes[0]!);
    let failure: Error = new Prisma.PrismaClientKnownRequestError('database connection closed during sync', {
      code: 'P1017',
      clientVersion: Prisma.prismaVersion.client,
    });
    let failing = true;
    // 仅在第二条 mutation 的指定数据库操作注入故障，其余读写走真实事务。
    const failingPrisma = new PrismaClient({ datasourceUrl: DATABASE_URL }).$extends({
      query: {
        transaction: {
          /** 用真实重复 INSERT 触发 PostgreSQL 唯一约束失败。 */
          async create({ args, query }) {
            if (failing && stage === '唯一约束' && args.data.id === ids[1]) {
              try {
                await query(args);
                return await query(args);
              } catch (cause) {
                if (cause instanceof Error) failure = cause;
                throw cause;
              }
            }
            return query(args);
          },
        },
        syncChange: {
          /** 在投影完成后的事件写入处模拟连接故障，验证事务回滚。 */
          async create({ args, query }) {
            if (failing && stage === '事件' && args.data.mutationId === changes[1]!.mutation_id) throw failure;
            return query(args);
          },
        },
      },
    });
    const records: string[] = [];
    const failures: Error[] = [];
    // 真实日志输出合并子 logger 的动作上下文；错误对象另从框架钩子读取以核验原始 cause 身份。
    const loggerHost = Fastify({ logger: { stream: { write: (record) => records.push(record) } } });
    const failingApp = buildApp({ logger: loggerHost.log, config, prisma: failingPrisma as unknown as PrismaClient });
    failingApp.addHook('onError', async (_request, _reply, error) => {
      failures.push(error);
    });
    const request = {
      method: 'POST' as const,
      url: `${API_BASE}/sync/push`,
      headers: { ...bearer(token), 'x-request-id': uuid() },
      payload: { device_id: deviceId, changes },
    };
    try {
      const response = await failingApp.inject(request);
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        code: 'SYNC_FAILED',
        message: '推送同步变更失败，请稍后重试',
        request_id: request.headers['x-request-id'],
      });
      const logs = records.map((record) => JSON.parse(record)).filter((record) => record.level >= 50);
      expect(logs).toEqual([
        expect.objectContaining({
          action: '推送同步变更',
          code: 'SYNC_FAILED',
          request_id: request.headers['x-request-id'],
        }),
      ]);
      expect(logs[0].err.message).toContain(failure.message);
      expect(logs[0].err.stack).toContain('revision.e2e.test.ts');
      expect(failures).toHaveLength(1);
      let rootCause: unknown = failures[0];
      while (rootCause instanceof Error && rootCause.cause !== undefined) rootCause = rootCause.cause;
      expect(rootCause).toBe(failure);
      if (stage === '唯一约束') expect(rootCause).toMatchObject({ code: 'P2002' });

      // 已提交的第一项保留；故障项的投影与事件一起回滚，第三项尚未执行。
      expect(await prisma.transaction.findMany({ where: { id: { in: ids } }, select: { id: true } })).toEqual([
        { id: ids[0] },
      ]);
      expect(await prisma.syncChange.count({ where: { mutationId: { in: changes.map((c) => c.mutation_id) } } })).toBe(
        1,
      );
      failing = false;
      const retried = await failingApp.inject(request);
      expect(retried.statusCode).toBe(200);
      expect(retried.json().outcomes.map((outcome: PushOutcome) => outcome.status)).toEqual([
        'ignored',
        'accepted',
        'accepted',
      ]);
      expect(await prisma.transaction.count({ where: { id: { in: ids } } })).toBe(3);
      expect(await prisma.syncChange.count({ where: { mutationId: { in: changes.map((c) => c.mutation_id) } } })).toBe(
        3,
      );
    } catch (error) {
      console.error('同步故障与重试验证失败', { stage, ledgerId, error });
      throw error;
    } finally {
      await failingApp.close();
      await loggerHost.close();
    }
  });

  it('UPDATE 对 tombstone：CONFLICT + current_deleted=true，绝不复活', async () => {
    const { token, deviceId, syncId, ledgerId } = await setupCloudLedger();
    const txnId = uuid();
    await api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, txnId), token);
    await api(
      'post',
      '/sync/push',
      txPush(deviceId, ledgerId, syncId, txnId, { baseRevision: 1, action: 'delete' }),
      token,
    );
    const push = await api(
      'post',
      '/sync/push',
      txPush(deviceId, ledgerId, syncId, txnId, { baseRevision: 2, note: '尝试复活' }),
      token,
    );
    expect(push.status).toBe(200);
    const outcome = (push.json() as { outcomes: PushOutcome[] }).outcomes[0]!;
    expect(outcome.status).toBe('conflict');
    expect(outcome.current_deleted).toBe(true);
    expect(outcome.current_revision).toBe(2);
    // 本地值未写入：实体保持 tombstone
    const dbTxn = await prisma.transaction.findUnique({ where: { id: txnId } });
    expect(dbTxn?.deletedAt).not.toBeNull();
    expect(dbTxn?.revision).toBe(2);
  });

  it('mutation_id 仅对同一请求幂等，复用到不同 base/payload 返回 409', async () => {
    const { token, deviceId, syncId, ledgerId } = await setupCloudLedger();
    const txnId = uuid();
    const mutationId = uuid();
    const first = await api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, txnId, { mutationId }), token);
    const firstOutcome = (first.json() as { outcomes: PushOutcome[] }).outcomes[0]!;
    expect(firstOutcome.status).toBe('accepted');
    const savedChange = await prisma.syncChange.findUnique({
      where: { deviceId_mutationId: { deviceId, mutationId } },
      select: { requestHash: true },
    });
    expect(savedChange?.requestHash).toMatch(/^[\da-f]{64}$/);

    const replay = await api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, txnId, { mutationId }), token);
    expect(replay.status).toBe(200);
    const replayOutcome = (replay.json() as { outcomes: PushOutcome[] }).outcomes[0]!;
    expect(replayOutcome.status).toBe('ignored');
    expect(replayOutcome.change_id).toBe(firstOutcome.change_id);

    const updated = await api(
      'post',
      '/sync/push',
      txPush(deviceId, ledgerId, syncId, txnId, {
        baseRevision: 1,
        note: '后来版本',
      }),
      token,
    );
    expect((updated.json() as { outcomes: PushOutcome[] }).outcomes[0]!.revision).toBe(2);
    const originalAgain = await api(
      'post',
      '/sync/push',
      txPush(deviceId, ledgerId, syncId, txnId, { mutationId }),
      token,
    );
    expect((originalAgain.json() as { outcomes: PushOutcome[] }).outcomes[0]).toMatchObject({
      status: 'ignored',
      revision: 1,
      change_id: firstOutcome.change_id,
    });
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: txnId } })).revision).toBe(2);
    const changedEnvelope = txPush(deviceId, ledgerId, syncId, txnId, { mutationId });
    changedEnvelope.changes[0]!.updated_at = '2026-08-22T11:00:00.001Z';
    const changedTime = await api('post', '/sync/push', changedEnvelope, token);
    expect(changedTime.status).toBe(409);
    expect((changedTime.json() as { code: string }).code).toBe('MUTATION_ID_REUSED');

    const reused = await api(
      'post',
      '/sync/push',
      txPush(deviceId, ledgerId, syncId, txnId, { mutationId, baseRevision: 3, note: '不同请求' }),
      token,
    );
    expect(reused.status).toBe(409);
    expect((reused.json() as { code: string }).code).toBe('MUTATION_ID_REUSED');
  });

  it('同一交易并发创建在同步锁下返回一个成功和一个完整冲突快照', async () => {
    const { token, deviceId, syncId, ledgerId } = await setupCloudLedger();
    const txnId = uuid();
    try {
      const responses = await Promise.all([
        api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, txnId, { note: '设备 A' }), token),
        api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, txnId, { note: '设备 B' }), token),
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      const outcomes = responses.map((response) => (response.json() as { outcomes: PushOutcome[] }).outcomes[0]!);
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['accepted', 'conflict']);
      const stored = await prisma.transaction.findUniqueOrThrow({ where: { id: txnId } });
      expect(stored.revision).toBe(1);
      const event = await prisma.syncChange.findFirstOrThrow({ where: { entityId: txnId } });
      expect(outcomes.find((outcome) => outcome.status === 'conflict')).toMatchObject({
        current_revision: 1,
        current_deleted: false,
        current_entity: event.payload,
      });
      expect(event.payload).toMatchObject({ id: txnId, revision: 1, note: stored.note });
      expect(await prisma.syncChange.count({ where: { entityId: txnId } })).toBe(1);
      expect(await prisma.transactionEditHistory.count({ where: { transactionId: txnId } })).toBe(0);
    } catch (cause) {
      console.error('同步交易并发创建验证失败', { ledgerId, txnId, cause });
      throw cause;
    }
  });

  it('并发 CAS：两个 mutation 同 base → 一个 accepted(revision+1)，一个 conflict', async () => {
    const { token, deviceId, syncId, ledgerId } = await setupCloudLedger();
    const txnId = uuid();
    await api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, txnId), token);
    const [a, b] = await Promise.all([
      api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, txnId, { baseRevision: 1, note: '并发A' }), token),
      api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, txnId, { baseRevision: 1, note: '并发B' }), token),
    ]);
    const statuses = [
      (a.json() as { outcomes: PushOutcome[] }).outcomes[0]!.status,
      (b.json() as { outcomes: PushOutcome[] }).outcomes[0]!.status,
    ].sort();
    expect(statuses).toEqual(['accepted', 'conflict']);
    const dbTxn = await prisma.transaction.findUnique({ where: { id: txnId } });
    expect(dbTxn?.revision).toBe(2);
  });

  it('per-mutation：同批一个 conflict 不阻塞其他实体（200 + 各自结果）', async () => {
    const { token, deviceId, syncId, ledgerId } = await setupCloudLedger();
    const t1 = uuid();
    const t2 = uuid();
    const t3 = uuid();
    await api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, t1), token);
    await api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, t2), token);
    // t1 先更新到 revision 2，batch 里 base=1 才过期 → conflict
    await api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, t1, { baseRevision: 1, note: '先更新' }), token);
    const batch = {
      device_id: deviceId,
      changes: [
        txPush(deviceId, ledgerId, syncId, t1, { baseRevision: 1, note: '过期' }).changes[0]!,
        txPush(deviceId, ledgerId, syncId, t2, { baseRevision: 1, note: '正常更新' }).changes[0]!,
        // t3 全新创建
        txPush(deviceId, ledgerId, syncId, t3).changes[0]!,
      ],
    };
    const push = await api('post', '/sync/push', batch, token);
    expect(push.status).toBe(200);
    const outcomes = (push.json() as { outcomes: PushOutcome[] }).outcomes;
    expect(outcomes.map((o) => o.status)).toEqual(['conflict', 'accepted', 'accepted']);
    expect(outcomes[1]!.revision).toBe(2);
    expect(outcomes[2]!.revision).toBe(1);
    const dbT2 = await prisma.transaction.findUnique({ where: { id: t2 } });
    expect(dbT2?.revision).toBe(2);
  });

  it('REST 与 push UPDATE 同步执行 CAS、分摊替换、编辑历史和变更事件', async () => {
    const { token, deviceId, syncId, ledgerId } = await setupCloudLedger();
    const restTxnId = uuid();
    const pushTxnId = uuid();
    await api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, restTxnId), token);
    await api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, pushTxnId), token);
    const ownerMember = await prisma.ledgerMember.findFirstOrThrow({
      where: { ledgerId, memberType: 'REGISTERED' },
    });
    const splits = [{ member_id: ownerMember.id, amount: '20' }];

    const rest = await api(
      'patch',
      `/ledgers/${ledgerId}/transactions/${restTxnId}`,
      { note: 'REST 更新', aa_mode: '2', splits, base_revision: 1 },
      token,
    );
    const push = await api(
      'post',
      '/sync/push',
      txPush(deviceId, ledgerId, syncId, pushTxnId, {
        note: 'push 更新',
        aaMode: '2',
        splits,
        baseRevision: 1,
      }),
      token,
    );
    expect(rest.status).toBe(200);
    expect((push.json() as { outcomes: PushOutcome[] }).outcomes[0]).toMatchObject({
      status: 'accepted',
      revision: 2,
    });

    for (const transactionId of [restTxnId, pushTxnId]) {
      const transaction = await prisma.transaction.findUniqueOrThrow({
        where: { id: transactionId },
        include: { splits: true, editHistory: true },
      });
      expect(transaction.revision).toBe(2);
      expect(transaction.splits).toHaveLength(1);
      expect(transaction.editHistory.map((history) => history.version)).toEqual([2]);
      expect(transaction.editHistory[0]!.operatorMemberId).toBe(ownerMember.id);
      const events = await prisma.syncChange.findMany({
        where: { entityId: transactionId, action: 'upsert' },
        orderBy: { changeId: 'asc' },
      });
      expect((events.at(-1)!.payload as { revision?: number }).revision).toBe(2);
    }
  });

  it('REST 与 push DELETE 都要求匹配 base revision，并写编辑历史和 delete 事件', async () => {
    const { token, deviceId, syncId, ledgerId } = await setupCloudLedger();
    const restTxnId = uuid();
    const pushTxnId = uuid();
    const staleTxnId = uuid();
    for (const transactionId of [restTxnId, pushTxnId, staleTxnId]) {
      await api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, transactionId), token);
    }

    const missingBase = await api('delete', `/ledgers/${ledgerId}/transactions/${staleTxnId}`, undefined, token);
    expect(missingBase.status).toBe(400);
    const stale = await api('delete', `/ledgers/${ledgerId}/transactions/${staleTxnId}`, { base_revision: 0 }, token);
    expect(stale.status).toBe(409);

    const rest = await api('delete', `/ledgers/${ledgerId}/transactions/${restTxnId}`, { base_revision: 1 }, token);
    const push = await api(
      'post',
      '/sync/push',
      txPush(deviceId, ledgerId, syncId, pushTxnId, { action: 'delete', baseRevision: 1 }),
      token,
    );
    expect(rest.status).toBe(204);
    expect((push.json() as { outcomes: PushOutcome[] }).outcomes[0]).toMatchObject({
      status: 'accepted',
      revision: 2,
    });

    for (const transactionId of [restTxnId, pushTxnId]) {
      const transaction = await prisma.transaction.findUniqueOrThrow({
        where: { id: transactionId },
        include: { editHistory: true },
      });
      expect(transaction).toMatchObject({ revision: 2 });
      expect(transaction.deletedAt).not.toBeNull();
      expect(transaction.editHistory.map((history) => history.version)).toEqual([2]);
      expect(transaction.editHistory[0]!.changes).toMatchObject({ action: 'delete', base_revision: 1 });
      const event = await prisma.syncChange.findFirstOrThrow({
        where: { entityId: transactionId, action: 'delete' },
        orderBy: { changeId: 'desc' },
      });
      expect(event.payload).toEqual({ revision: 2 });
    }

    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: staleTxnId } })).toMatchObject({
      revision: 1,
      deletedAt: null,
    });
  });
});
