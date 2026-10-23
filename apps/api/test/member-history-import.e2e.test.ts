import { testStoragePath } from './test-storage-path.js';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { registeredMemberId } from '../src/modules/accounting/index.js';

import { assertGuardedTestDatabase, guardedTestDatabaseUrl } from './existing-test-database.js';

const url = guardedTestDatabaseUrl(process.env.E2E_DATABASE_URL, process.env);
const prisma = new PrismaClient({ datasourceUrl: url });
const app = buildApp({
  logger: false,
  prisma,
  config: {
    ...loadConfig({
      DATABASE_URL: url,
      JWT_SECRET: 'member-history-test-secret-at-least-32-characters',
      STORAGE_PATH: testStoragePath('member-history-import'),
    }),
    rateLimitMax: 1000,
    authRateLimitMax: 1000,
  },
});
type Session = { access_token: string; device_id: string; user: { user_id: string } };
type Ledger = { id: string; sync_id: string };
type Context = { session: Session; ledger: Ledger };
beforeAll(async () => {
  await assertGuardedTestDatabase(prisma, url, process.env);
  await app.ready();
});
afterAll(() => app.close());
/** 使用真实鉴权和 HTTP 请求，能力头不授予历史导入权限。 */
function request(session: Session, path: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', payload?: object) {
  return app.inject({
    method,
    url: `/api/v1${path}`,
    headers: {
      authorization: `Bearer ${session.access_token}`,
    },
    ...(payload ? { payload } : {}),
  });
}
/** 每案使用独立真实账号，避免假造 owner/editor 权限。 */
async function register() {
  const result = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      country_code: '+86',
      phone: `138${randomInt(100000000).toString().padStart(8, '0')}`,
      password: 'member-history-password',
      device: { installation_id: randomUUID(), name: '历史成员测试', platform: 'test' },
    },
  });
  expect(result.statusCode, result.body).toBe(201);
  return result.json<Session>();
}
/** 创建独立目标账本，普通目录初始化与正式路径保持一致。 */
async function setup(): Promise<Context> {
  const session = await register();
  const result = await request(session, '/ledgers', 'POST', {
    name: '历史成员账本',
    currency: 'CNY',
    aa_enabled: true,
  });
  expect(result.statusCode, result.body).toBe(201);
  return { session, ledger: result.json<Ledger>() };
}
/** 冻结变更身份和载荷，重放直接复用同一对象。 */
function change(
  ctx: Context,
  type: 'member' | 'transaction',
  id: string,
  payload: Record<string, unknown>,
  extra: object = {},
) {
  return {
    mutation_id: randomUUID(),
    entity_type: type,
    entity_id: id,
    ledger_id: ctx.ledger.id,
    sync_id: ctx.ledger.sync_id,
    action: 'upsert',
    updated_at: new Date().toISOString(),
    base_revision: 0,
    payload,
    ...extra,
  };
}
/** 读取每条 mutation 的真实结果，HTTP 成功不代替业务成功。 */
async function push(ctx: Context, item: ReturnType<typeof change>) {
  const response = await request(ctx.session, '/sync/push', 'POST', {
    device_id: ctx.session.device_id,
    changes: [item],
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ outcomes: Array<{ status: string; change_id: string | null; revision?: number }> }>()
    .outcomes[0]!;
}
/** 显式导入历史成员，不临时激活，也不建立关联账号或管理角色。 */
async function historicalMember(ctx: Context, status: 'ACTIVE' | 'LEFT' | 'REMOVED') {
  const id = randomUUID();
  const item = change(ctx, 'member', id, { display_name: `历史${status}`, initial_status: status });
  expect((await push(ctx, item)).status).toBe('accepted');
  return { id, item };
}
/** 构造普通历史交易，所有金额与分摊仍经正式规则验证。 */
function transaction(payer: string, split: string) {
  return {
    tx_type: 'expense',
    amount: '10.1234567891',
    native_amount: '10.1234567891',
    currency_code: 'CNY',
    happened_at: '2024-01-01T00:00:00.000Z',
    category_id: null,
    note: '历史交易',
    recurring_id: null,
    payer_member_id: payer,
    aa_mode: '2',
    splits: [{ member_id: split, amount: '10.1234567891' }],
    last_edited_at: null,
  };
}

it.each(['ACTIVE', 'LEFT', 'REMOVED'] as const)(
  'owner首次历史成员保持%s及固定重放，不允许新mutation改生命周期',
  async (status) => {
    const ctx = await setup();
    const { id, item } = await historicalMember(ctx, status);
    const events = await prisma.syncChange.count({ where: { entityId: id } });
    expect(await push(ctx, item)).toMatchObject({ status: 'ignored' });
    expect(
      (
        await push(ctx, {
          ...item,
          mutation_id: randomUUID(),
          updated_at: '1970-01-01T00:00:00.000Z',
          payload: { display_name: '试图恢复', initial_status: 'ACTIVE' },
        })
      ).status,
    ).toBe('invalid');
    const row = await prisma.ledgerMember.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status, memberType: 'PLACEHOLDER', linkedAccountId: null, role: 'editor' });
    expect(await prisma.syncChange.count({ where: { entityId: id } })).toBe(events);
    const full = await request(ctx.session, `/sync/full?ledger_id=${ctx.ledger.id}`);
    expect(full.statusCode, full.body).toBe(200);
    expect(full.json().members.find((member: { id: string }) => member.id === id)).toMatchObject({
      status,
      member_type: 'PLACEHOLDER',
    });
  },
);

it('旧普通成员保持ACTIVE；LEFT改名保持LEFT，REMOVED不因普通改名复活', async () => {
  const ctx = await setup();
  const active = randomUUID();
  expect((await push(ctx, change(ctx, 'member', active, { display_name: '普通新增' }))).status).toBe('accepted');
  expect((await prisma.ledgerMember.findUniqueOrThrow({ where: { id: active } })).status).toBe('ACTIVE');
  for (const status of ['LEFT', 'REMOVED'] as const) {
    const { id } = await historicalMember(ctx, status);
    const result = await push(
      ctx,
      change(
        ctx,
        'member',
        id,
        { display_name: '历史改名' },
        { updated_at: new Date(Date.now() + 1000).toISOString() },
      ),
    );
    expect(result.status).toBe(status === 'LEFT' ? 'accepted' : 'invalid');
    expect((await prisma.ledgerMember.findUniqueOrThrow({ where: { id } })).status).toBe(status);
  }
});

it('editor即使旧时间或base0也不能借历史标记创建或覆盖成员和交易', async () => {
  const ctx = await setup();
  const { id } = await historicalMember(ctx, 'LEFT');
  const editor = await register();
  await prisma.ledgerMember.create({
    data: {
      id: registeredMemberId(ctx.ledger.id, editor.user.user_id),
      ledgerId: ctx.ledger.id,
      memberType: 'REGISTERED',
      linkedAccountId: editor.user.user_id,
      role: 'editor',
      status: 'ACTIVE',
      displayName: '编辑者',
    },
  });
  const peer = { ...ctx, session: editor };
  for (const target of [id, randomUUID()]) {
    expect(
      (
        await push(
          peer,
          change(
            peer,
            'member',
            target,
            { display_name: '越权历史', initial_status: 'LEFT' },
            { updated_at: '1970-01-01T00:00:00.000Z' },
          ),
        )
      ).status,
    ).toBe('invalid');
  }
  const txId = randomUUID();
  expect(
    (await push(peer, change(peer, 'transaction', txId, { ...transaction(id, id), initial_history: true }))).status,
  ).toBe('invalid');
  expect(await prisma.transaction.findUnique({ where: { id: txId } })).toBeNull();
});

it('owner历史交易接受本账本inactive付款和分摊，丢回执重放不重复且不回写成员状态', async () => {
  const ctx = await setup();
  const payer = await historicalMember(ctx, 'LEFT');
  const split = await historicalMember(ctx, 'REMOVED');
  const id = randomUUID();
  const item = change(ctx, 'transaction', id, { ...transaction(payer.id, split.id), initial_history: true });
  const accepted = await push(ctx, item);
  expect(accepted.status).toBe('accepted');
  expect(await push(ctx, item)).toMatchObject({ status: 'ignored', change_id: accepted.change_id });
  const stored = await prisma.transaction.findUniqueOrThrow({ where: { id }, include: { splits: true } });
  expect(stored.nativeAmount.toFixed(10)).toBe('10.1234567891');
  expect(stored).toMatchObject({ payerMemberId: payer.id, revision: 1 });
  expect(stored.splits[0]).toMatchObject({ memberId: split.id });
  expect((await prisma.ledgerMember.findUniqueOrThrow({ where: { id: payer.id } })).status).toBe('LEFT');
  expect((await prisma.ledgerMember.findUniqueOrThrow({ where: { id: split.id } })).status).toBe('REMOVED');
  expect(await prisma.syncChange.count({ where: { entityId: id } })).toBe(1);
  expect((await push(ctx, { ...item, mutation_id: randomUUID(), updated_at: '1970-01-01T00:00:00.000Z' })).status).toBe(
    'invalid',
  );
});

it('无标记的新同步/REST交易仍拒绝inactive，标记也不能跨账本引用', async () => {
  const ctx = await setup();
  const member = await historicalMember(ctx, 'LEFT');
  const payload = transaction(member.id, member.id);
  expect((await push(ctx, change(ctx, 'transaction', randomUUID(), payload))).status).toBe('invalid');
  const rest = await request(ctx.session, `/ledgers/${ctx.ledger.id}/transactions`, 'POST', {
    id: randomUUID(),
    ...payload,
  });
  expect(rest.statusCode, rest.body).toBe(400);
  const other = await setup();
  const id = randomUUID();
  expect((await push(other, change(other, 'transaction', id, { ...payload, initial_history: true }))).status).toBe(
    'invalid',
  );
  expect(await prisma.transaction.findUnique({ where: { id } })).toBeNull();
});

it('历史编辑只保留原付款/分摊集合，REST及sync不能新增其他inactive或复活交易墓碑', async () => {
  const ctx = await setup();
  const payer = await historicalMember(ctx, 'LEFT');
  const split = await historicalMember(ctx, 'REMOVED');
  const other = await historicalMember(ctx, 'LEFT');
  const id = randomUUID();
  const payload = transaction(payer.id, split.id);
  expect((await push(ctx, change(ctx, 'transaction', id, { ...payload, initial_history: true }))).status).toBe(
    'accepted',
  );
  const path = `/ledgers/${ctx.ledger.id}/transactions/${id}`;
  const edited = await request(ctx.session, path, 'PATCH', {
    base_revision: 1,
    note: '保留历史',
    payer_member_id: payer.id,
    splits: payload.splits,
  });
  expect(edited.statusCode, edited.body).toBe(200);
  expect(
    (await push(ctx, change(ctx, 'transaction', id, { ...payload, note: '同步保留历史' }, { base_revision: 2 })))
      .status,
  ).toBe('accepted');
  for (const changed of [
    { payer_member_id: other.id },
    { splits: [{ member_id: other.id, amount: payload.native_amount }] },
  ]) {
    const rest = await request(ctx.session, path, 'PATCH', { base_revision: 3, ...changed });
    expect(rest.statusCode, rest.body).toBe(400);
    expect(
      (await push(ctx, change(ctx, 'transaction', id, { ...payload, ...changed }, { base_revision: 3 }))).status,
    ).toBe('invalid');
  }
  expect((await prisma.transaction.findUniqueOrThrow({ where: { id } })).revision).toBe(3);
  const deletion = change(ctx, 'transaction', id, {}, { action: 'delete', base_revision: 3 });
  expect((await push(ctx, deletion)).status).toBe('accepted');
  expect((await push(ctx, change(ctx, 'transaction', id, { ...payload, initial_history: true }))).status).toBe(
    'invalid',
  );
  expect((await push(ctx, change(ctx, 'transaction', id, payload, { base_revision: 4 }))).status).toBe('conflict');
  expect((await prisma.transaction.findUniqueOrThrow({ where: { id } })).deletedAt).not.toBeNull();
});

it('首次历史标记拒绝非零基线、非布尔true及周期来源，不留部分交易', async () => {
  const ctx = await setup();
  const member = await historicalMember(ctx, 'LEFT');
  const memberId = randomUUID();
  expect(
    (
      await push(
        ctx,
        change(ctx, 'member', memberId, { display_name: '错误基线', initial_status: 'LEFT' }, { base_revision: 1 }),
      )
    ).status,
  ).toBe('invalid');
  expect(await prisma.ledgerMember.findUnique({ where: { id: memberId } })).toBeNull();
  for (const [fields, base] of [
    [{}, 1],
    [{ initial_history: 'true' }, 0],
    [{ recurring_id: randomUUID() }, 0],
  ] as const) {
    const id = randomUUID();
    const item = change(
      ctx,
      'transaction',
      id,
      { ...transaction(member.id, member.id), initial_history: true, ...fields },
      { base_revision: base },
    );
    expect((await push(ctx, item)).status).toBe('invalid');
    expect(await prisma.transaction.findUnique({ where: { id } })).toBeNull();
  }
});

it('并发首次历史成员请求只创建一次，后到请求不能改变已建立生命周期', async () => {
  const ctx = await setup();
  const id = randomUUID();
  const results = await Promise.all(
    ['LEFT', 'REMOVED'].map((status) =>
      push(ctx, change(ctx, 'member', id, { display_name: '并发历史', initial_status: status })),
    ),
  );
  expect(results.map((row) => row.status).sort()).toEqual(['accepted', 'invalid']);
  expect(['LEFT', 'REMOVED']).toContain((await prisma.ledgerMember.findUniqueOrThrow({ where: { id } })).status);
  expect(await prisma.syncChange.count({ where: { entityId: id } })).toBe(1);
});
