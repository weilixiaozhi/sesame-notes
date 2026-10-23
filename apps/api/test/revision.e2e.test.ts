import { testStoragePath } from './test-storage-path.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';

import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { ApiError } from '../src/shared/errors.js';

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
  it('REST、完整快照、创建事件和冲突快照保留相同的交易与分摊数据', async () => {
    const { token, deviceId, syncId, ledgerId } = await setupCloudLedger();
    try {
      const memberIds = [uuid(), uuid()].sort();
      await prisma.ledgerMember.createMany({
        data: memberIds.map((id) => ({
          id,
          ledgerId,
          displayName: '分摊成员',
          memberType: 'PLACEHOLDER',
          role: 'editor',
        })),
      });
      const txnId = uuid();
      // 逆序提交不同金额，验证排序不会改变成员与金额的对应关系。
      const splits = [
        { member_id: memberIds[1]!, amount: '12.34' },
        { member_id: memberIds[0]!, amount: '7.66' },
      ];
      const pushed = await api(
        'post',
        '/sync/push',
        txPush(deviceId, ledgerId, syncId, txnId, { aaMode: '2', splits }),
        token,
      );
      expect(pushed.status).toBe(200);
      expect((pushed.json() as { outcomes: PushOutcome[] }).outcomes[0]!.status).toBe('accepted');
      const rest = await api('get', `/ledgers/${ledgerId}/transactions`, undefined, token);
      expect(rest.status).toBe(200);
      const transaction = (rest.json() as { items: unknown[] }).items[0];
      expect(transaction).toMatchObject({ id: txnId, aa_mode: '2', amount: '20', splits: [...splits].reverse() });

      const full = await api('get', '/sync/accounting/full', undefined, token);
      expect(full.status).toBe(200);
      expect(
        (full.json() as { ledger_snapshots: Array<{ transactions: unknown[] }> }).ledger_snapshots[0]!.transactions,
      ).toEqual([transaction]);
      const event = await prisma.syncChange.findFirstOrThrow({ where: { entityId: txnId, action: 'upsert' } });
      expect(event.payload).toEqual(transaction);

      const conflicted = await api(
        'post',
        '/sync/push',
        txPush(deviceId, ledgerId, syncId, txnId, { aaMode: '2', splits, baseRevision: 0 }),
        token,
      );
      expect(conflicted.status).toBe(200);
      expect((conflicted.json() as { outcomes: PushOutcome[] }).outcomes[0]).toMatchObject({
        status: 'conflict',
        current_entity: transaction,
      });
    } catch (error) {
      console.error('交易跨入口快照一致性验证失败', { ledgerId, error });
      throw error;
    }
  });

  it.each(['读取', '投影', '快照', '事件'] as const)('同步%s故障回滚并记录根因，整批重试不重复提交', async (stage) => {
    const { token, deviceId, syncId, ledgerId } = await setupCloudLedger();
    const ids = [uuid(), uuid(), uuid()];
    const changes = ids.map((id) => txPush(deviceId, ledgerId, syncId, id).changes[0]!);
    const failure =
      stage === '投影'
        ? new ApiError(500, 'SYNC_FAILED', '推送同步变更失败，请稍后重试')
        : new Prisma.PrismaClientKnownRequestError('database connection closed during sync', {
            code: 'P1017',
            clientVersion: Prisma.prismaVersion.client,
          });
    let failing = true;
    // 仅在第二条 mutation 的指定数据库操作注入故障，其余读写走真实事务。
    const failingPrisma = new PrismaClient({ datasourceUrl: DATABASE_URL }).$extends({
      query: {
        transaction: {
          /** 在目标交易读取时模拟连接故障。 */
          async findUnique({ args, query }) {
            if (failing && stage === '读取' && args.where.id === ids[1]) throw failure;
            return query(args);
          },
          /** 在创建后的权威快照读取处模拟故障，确保不会用客户端载荷写入事件。 */
          async findUniqueOrThrow({ args, query }) {
            if (failing && stage === '快照' && args.where.id === ids[1]) throw failure;
            return query(args);
          },
          /** 在目标投影写入时模拟已分类的服务端故障。 */
          async create({ args, query }) {
            if (failing && stage === '投影' && args.data.id === ids[1]) throw failure;
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

  it('输入拒绝保持稳定：非法 AA 模式返回 400，分摊不一致逐项 invalid，合法项继续提交', async () => {
    const { token, deviceId, syncId, ledgerId } = await setupCloudLedger();
    try {
      const malformed = txPush(deviceId, ledgerId, syncId, uuid());
      const malformedChange = malformed.changes[0]!;
      const rejected = await api(
        'post',
        '/sync/push',
        {
          ...malformed,
          changes: [{ ...malformedChange, payload: { ...malformedChange.payload, aa_mode: '3' } }],
        },
        token,
      );
      expect(rejected.status).toBe(400);
      expect(rejected.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
      const invalid = txPush(deviceId, ledgerId, syncId, uuid(), {
        aaMode: '2',
        splits: [{ member_id: uuid(), amount: '19' }],
      }).changes[0]!;
      const valid = txPush(deviceId, ledgerId, syncId, uuid()).changes[0]!;
      const response = await api('post', '/sync/push', { device_id: deviceId, changes: [invalid, valid] }, token);
      expect(response.status).toBe(200);
      expect(response.json()).toMatchObject({
        outcomes: [
          { status: 'invalid', message: 'AA 指定分摊金额与交易折算金额不一致', change_id: null },
          { status: 'accepted', entity_id: valid.entity_id, revision: 1 },
        ],
      });
      expect(await prisma.transaction.findUnique({ where: { id: invalid.entity_id } })).toBeNull();
      expect(await prisma.syncChange.count({ where: { mutationId: invalid.mutation_id } })).toBe(0);
    } catch (error) {
      console.error('同步输入拒绝验证失败', { ledgerId, error });
      throw error;
    }
  });

  it('CREATE（无 base_revision）：revision 1', async () => {
    const { token, deviceId, syncId, ledgerId } = await setupCloudLedger();
    const txnId = uuid();
    const push = await api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, txnId), token);
    expect(push.status).toBe(200);
    const outcome = (push.json() as { outcomes: PushOutcome[] }).outcomes[0]!;
    expect(outcome.status).toBe('accepted');
    expect(outcome.revision).toBe(1);
    const dbTxn = await prisma.transaction.findUnique({ where: { id: txnId } });
    expect(dbTxn?.revision).toBe(1);
    expect(dbTxn?.deletedAt).toBeNull();
  });

  it('UPDATE（base=N）：revision N+1', async () => {
    const { token, deviceId, syncId, ledgerId } = await setupCloudLedger();
    const txnId = uuid();
    await api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, txnId), token);
    const push = await api(
      'post',
      '/sync/push',
      txPush(deviceId, ledgerId, syncId, txnId, { baseRevision: 1, note: '改备注' }),
      token,
    );
    expect(push.status).toBe(200);
    const outcome = (push.json() as { outcomes: PushOutcome[] }).outcomes[0]!;
    expect(outcome.status).toBe('accepted');
    expect(outcome.revision).toBe(2);
    const dbTxn = await prisma.transaction.findUnique({ where: { id: txnId } });
    expect(dbTxn?.revision).toBe(2);
    expect(dbTxn?.note).toBe('改备注');
  });

  it('UPDATE base 过期：CONFLICT（current_revision + current_entity 供 UI）', async () => {
    const { token, deviceId, syncId, ledgerId } = await setupCloudLedger();
    const txnId = uuid();
    await api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, txnId), token);
    await api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, txnId, { baseRevision: 1 }), token);
    const push = await api(
      'post',
      '/sync/push',
      txPush(deviceId, ledgerId, syncId, txnId, { baseRevision: 1, note: '过期 base' }),
      token,
    );
    expect(push.status).toBe(200);
    const outcome = (push.json() as { outcomes: PushOutcome[] }).outcomes[0]!;
    expect(outcome.status).toBe('conflict');
    expect(outcome.current_revision).toBe(2);
    expect(outcome.current_deleted).toBe(false);
    expect(outcome.current_entity).toBeTruthy();
    // 冲突不落库：本地值未覆盖云端
    const dbTxn = await prisma.transaction.findUnique({ where: { id: txnId } });
    expect(dbTxn?.note).not.toBe('过期 base');
    expect(dbTxn?.revision).toBe(2);
  });

  it('DELETE（base=N）：tombstone revision N+1，delete 事件 payload 带 revision', async () => {
    const { token, deviceId, syncId, ledgerId } = await setupCloudLedger();
    const txnId = uuid();
    await api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, txnId), token);
    const push = await api(
      'post',
      '/sync/push',
      txPush(deviceId, ledgerId, syncId, txnId, { baseRevision: 1, action: 'delete' }),
      token,
    );
    expect(push.status).toBe(200);
    const outcome = (push.json() as { outcomes: PushOutcome[] }).outcomes[0]!;
    expect(outcome.status).toBe('accepted');
    expect(outcome.revision).toBe(2);
    const dbTxn = await prisma.transaction.findUnique({ where: { id: txnId } });
    expect(dbTxn?.revision).toBe(2);
    expect(dbTxn?.deletedAt).not.toBeNull();
    // delete 事件必须带 revision
    const events = await prisma.syncChange.findMany({ where: { entityId: txnId, action: 'delete' } });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect((events.at(-1)!.payload as { revision?: number }).revision).toBe(2);
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

  it('DELETE 对不存在实体：no-op（ignored，无事件产生）', async () => {
    const { token, deviceId, syncId, ledgerId } = await setupCloudLedger();
    const txnId = uuid();
    // 按实体维度统计：测试文件并发共享数据库时全局 count 会受其他实体事件污染
    const before = await prisma.syncChange.count({ where: { entityId: txnId } });
    const push = await api(
      'post',
      '/sync/push',
      txPush(deviceId, ledgerId, syncId, txnId, { baseRevision: 1, action: 'delete' }),
      token,
    );
    expect(push.status).toBe(200);
    const outcome = (push.json() as { outcomes: PushOutcome[] }).outcomes[0]!;
    expect(outcome.status).toBe('ignored');
    const after = await prisma.syncChange.count({ where: { entityId: txnId } });
    expect(after).toBe(before);
  });

  it('CREATE 已存在实体（无 base）：CONFLICT（不静默覆盖）', async () => {
    const { token, deviceId, syncId, ledgerId } = await setupCloudLedger();
    const txnId = uuid();
    await api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, txnId), token);
    const push = await api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, txnId), token);
    const outcome = (push.json() as { outcomes: PushOutcome[] }).outcomes[0]!;
    expect(outcome.status).toBe('conflict');
    expect(outcome.current_revision).toBe(1);
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

  it('并发复用 mutation_id 到不同请求时，一个成功、一个明确 409', async () => {
    const { token, deviceId, syncId, ledgerId } = await setupCloudLedger();
    const txnId = uuid();
    const mutationId = uuid();
    const [left, right] = await Promise.all([
      api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, txnId, { mutationId, note: '请求 A' }), token),
      api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, txnId, { mutationId, note: '请求 B' }), token),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 409]);
    const rejected = left.status === 409 ? left : right;
    expect((rejected.json() as { code: string }).code).toBe('MUTATION_ID_REUSED');
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

  it('per-mutation：非法 payload 返回 invalid，同批其他实体正常应用', async () => {
    const { token, deviceId, syncId, ledgerId } = await setupCloudLedger();
    const tOk = uuid();
    const tBad = uuid();
    const badChange = {
      mutation_id: uuid(),
      entity_type: 'transaction',
      entity_id: tBad,
      ledger_id: ledgerId,
      sync_id: syncId,
      action: 'upsert',
      updated_at: '2026-08-22T11:00:00.000Z',
      payload: {
        tx_type: 'expense',
        // 本位币交易折算金额与原始金额不一致：schema 合法、服务端业务校验拒绝（INVALID_NATIVE_AMOUNT）
        amount: '20',
        happened_at: '2026-08-22T11:00:00.000Z',
        note: null,
        category_id: null,
        currency_code: 'CNY',
        native_amount: '30',
        recurring_id: null,
        paid_by_user_id: null,
        aa_mode: null,
        splits: [],
        last_edited_at: null,
      },
    };
    const push = await api(
      'post',
      '/sync/push',
      {
        device_id: deviceId,
        changes: [badChange, txPush(deviceId, ledgerId, syncId, tOk).changes[0]!],
      },
      token,
    );
    expect(push.status).toBe(200);
    const outcomes = (push.json() as { outcomes: PushOutcome[] }).outcomes;
    expect(outcomes[0]!.status).toBe('invalid');
    expect(outcomes[1]!.status).toBe('accepted');
    expect(outcomes[1]!.revision).toBe(1);
    const dbBad = await prisma.transaction.findUnique({ where: { id: tBad } });
    expect(dbBad).toBeNull();
  });

  it('REST PATCH 缺失 base_revision：400；匹配时更新；过期时 409', async () => {
    const { token, deviceId, syncId, ledgerId } = await setupCloudLedger();
    const txnId = uuid();
    await api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, txnId), token);

    const missingBase = await api('patch', `/ledgers/${ledgerId}/transactions/${txnId}`, { note: '缺少基线' }, token);
    expect(missingBase.status).toBe(400);
    expect((missingBase.json() as { code: string }).code).toBe('VALIDATION_ERROR');
    expect(await prisma.transaction.findUnique({ where: { id: txnId } })).toMatchObject({
      revision: 1,
      note: '同步交易',
    });

    // 匹配当前 revision 时更新到 2，随后复用旧基线必须冲突。
    const firstPatch = await api(
      'patch',
      `/ledgers/${ledgerId}/transactions/${txnId}`,
      { note: '先更新', base_revision: 1 },
      token,
    );
    expect(firstPatch.status).toBe(200);
    const conflicted = await api(
      'patch',
      `/ledgers/${ledgerId}/transactions/${txnId}`,
      { note: 'REST 过期', base_revision: 1 },
      token,
    );
    expect(conflicted.status).toBe(409);
    const conflictBody = conflicted.json() as { code: string; details?: { current_revision?: number } };
    expect(conflictBody.code).toBe('SYNC_CONFLICT');
    expect(conflictBody.details?.current_revision).toBe(2);
    const ok = await api(
      'patch',
      `/ledgers/${ledgerId}/transactions/${txnId}`,
      { note: 'REST 正常', base_revision: 2 },
      token,
    );
    expect(ok.status).toBe(200);
    const dbTxn = await prisma.transaction.findUnique({ where: { id: txnId } });
    expect(dbTxn?.revision).toBe(3);
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

  it('pull 事件 payload 带 revision（事务 upsert 事件为服务端权威快照）', async () => {
    const { token, deviceId, syncId, ledgerId } = await setupCloudLedger();
    const txnId = uuid();
    await api('post', '/sync/push', txPush(deviceId, ledgerId, syncId, txnId), token);
    const pull = await api('get', '/sync/pull?since=0', undefined, token);
    expect(pull.status).toBe(200);
    const pulled = pull.json() as {
      changes: Array<{ entity_type: string; entity_id: string; payload: Record<string, unknown> }>;
    };
    const txEvent = pulled.changes.find((c) => c.entity_type === 'transaction' && c.entity_id === txnId);
    expect(txEvent).toBeTruthy();
    expect(txEvent!.payload.revision).toBe(1);
  });
});
