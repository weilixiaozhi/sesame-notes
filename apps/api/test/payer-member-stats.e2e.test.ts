import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadTestApiConfig } from './test-api-config.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';

const databaseUrl = testFixtureDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = buildApp({
  logger: false,
  prisma,
  config: { ...loadTestApiConfig(), databaseUrl, authRateLimitMax: 1000, rateLimitMax: 1000 },
});
type Session = { access_token: string; user: { user_id: string } };
beforeAll(() => app.ready());
afterAll(() => app.close());

/** 注册隔离账号并保持真实鉴权入口。 */
async function register(): Promise<Session> {
  const result = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      country_code: '+86',
      phone: `138${randomInt(100000000).toString().padStart(8, '0')}`,
      password: 'payer-member-stats-test-password',
      device: { installation_id: randomUUID(), name: '付款统计测试', platform: 'test' },
    },
  });
  expect(result.statusCode, result.body).toBe(201);
  return result.json<Session>();
}

/** 经真实 HTTP 读写账本；聚合测试只在专属测试库准备精确金额与历史身份。 */
function api(session: Session, method: 'GET' | 'POST', path: string, payload?: object) {
  return app.inject({
    method,
    url: `/api/v1${path}`,
    headers: { authorization: `Bearer ${session.access_token}` },
    ...(payload ? { payload } : {}),
  });
}

/** 默认建立非 AA 账本，证明付款统计不依赖 AA 开关。 */
async function fixture() {
  const owner = await register();
  const created = await api(owner, 'POST', '/ledgers', {
    name: '付款人汇总隐私账本',
    currency: 'CNY',
    aa_enabled: false,
  });
  expect(created.statusCode, created.body).toBe(201);
  const ledgerId = created.json<{ id: string }>().id;
  const ownerMember = await prisma.ledgerMember.findFirstOrThrow({
    where: { ledgerId, linkedAccountId: owner.user.user_id },
  });
  const participant = await prisma.ledgerMember.create({
    data: { id: randomUUID(), ledgerId, displayName: '付款参与者', memberType: 'PLACEHOLDER', role: 'editor' },
  });
  return { owner, ledgerId, ownerMember, participant };
}

it('成员统计汇总全部有效支出，付款维度保留历史成员并排除无付款者与零交易成员', async () => {
  const { owner, ledgerId, ownerMember, participant } = await fixture();
  const editor = await register();
  const invite = await api(owner, 'POST', `/ledgers/${ledgerId}/invites`, {});
  expect(invite.statusCode, invite.body).toBe(201);
  const joined = await api(editor, 'POST', `/invites/${invite.json<{ code: string }>().code}/accept`, {});
  expect(joined.statusCode, joined.body).toBe(200);
  const editorMember = await prisma.ledgerMember.findFirstOrThrow({
    where: { ledgerId, linkedAccountId: editor.user.user_id },
  });
  const removed = await prisma.ledgerMember.create({
    data: {
      id: randomUUID(),
      ledgerId,
      displayName: '历史付款人',
      memberType: 'PLACEHOLDER',
      role: 'editor',
      status: 'REMOVED',
    },
  });
  const unused = await prisma.ledgerMember.create({
    data: { id: randomUUID(), ledgerId, displayName: '无付款成员', memberType: 'PLACEHOLDER', role: 'editor' },
  });
  const base = {
    ledgerId,
    ownerId: owner.user.user_id,
    txType: 'expense',
    currencyCode: 'CNY',
    happenedAt: new Date('2026-09-20T00:00:00Z'),
    createdByMemberId: ownerMember.id,
  };
  await prisma.transaction.createMany({
    data: [
      {
        ...base,
        id: randomUUID(),
        amount: '10',
        nativeAmount: '70',
        currencyCode: 'USD',
        payerMemberId: editorMember.id,
      },
      {
        ...base,
        id: randomUUID(),
        amount: '30',
        nativeAmount: '30',
        payerMemberId: participant.id,
        createdByMemberId: editorMember.id,
      },
      { ...base, id: randomUUID(), amount: '20', nativeAmount: '20', payerMemberId: editorMember.id },
      { ...base, id: randomUUID(), amount: '11', nativeAmount: '11', payerMemberId: null },
      {
        ...base,
        id: randomUUID(),
        amount: '5',
        nativeAmount: '5',
        payerMemberId: ownerMember.id,
        deletedAt: new Date('2026-09-21T00:00:00Z'),
      },
      {
        ...base,
        id: randomUUID(),
        amount: '0.0000000001',
        nativeAmount: '0.0000000001',
        payerMemberId: removed.id,
        createdByMemberId: editorMember.id,
      },
    ],
  });
  await prisma.ledgerMember.update({ where: { id: editorMember.id }, data: { status: 'LEFT' } });
  const response = await api(owner, 'GET', `/ledgers/${ledgerId}/member-stats?dimension=payer&scope=all`);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ ledger_currency: 'CNY', scope: 'all', start_at: null, end_at: null });
  expect(response.json().items).toEqual([
    expect.objectContaining({ member_id: editorMember.id, role: 'removed', expense_total: '90', tx_count: 2 }),
    expect.objectContaining({ member_id: participant.id, expense_total: '30', tx_count: 1 }),
    expect.objectContaining({ member_id: removed.id, role: 'removed', expense_total: '0.0000000001', tx_count: 1 }),
  ]);
  expect(response.body).not.toContain(unused.id);
  expect(response.body).not.toContain('phone');
  expect(response.body).not.toContain('country_code');
  const defaultCreator = await api(owner, 'GET', `/ledgers/${ledgerId}/member-stats?scope=all`);
  const explicitCreator = await api(owner, 'GET', `/ledgers/${ledgerId}/member-stats?scope=all&dimension=creator`);
  expect(defaultCreator.statusCode, defaultCreator.body).toBe(200);
  expect(explicitCreator.statusCode, explicitCreator.body).toBe(200);
  expect(defaultCreator.json()).toEqual(explicitCreator.json());
  expect(defaultCreator.json().items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ member_id: ownerMember.id, expense_total: '101', tx_count: 3 }),
      expect.objectContaining({ member_id: editorMember.id, expense_total: '30.0000000001', tx_count: 2 }),
      expect.objectContaining({ member_id: unused.id, expense_total: '0', tx_count: 0 }),
    ]),
  );
  const denied = await api(editor, 'GET', `/ledgers/${ledgerId}/member-stats?dimension=payer&scope=all`);
  expect(denied.statusCode, denied.body).toBe(404);
  expect(denied.body).not.toContain('expense_total');
});

it('付款维度沿用账本月起始日、时区和左闭右开范围', async () => {
  const { owner, ledgerId, ownerMember, participant } = await fixture();
  await prisma.ledger.update({ where: { id: ledgerId }, data: { monthStartDay: 15 } });
  const times = [
    '2026-09-14T15:59:59.999Z',
    '2026-09-14T16:00:00.000Z',
    '2026-10-14T15:59:59.999Z',
    '2026-10-14T16:00:00.000Z',
  ];
  await prisma.transaction.createMany({
    data: times.map((time, index) => ({
      id: randomUUID(),
      ledgerId,
      ownerId: owner.user.user_id,
      txType: 'expense',
      currencyCode: 'CNY',
      amount: String(index + 1),
      nativeAmount: String(index + 1),
      happenedAt: new Date(time),
      payerMemberId: participant.id,
      createdByMemberId: ownerMember.id,
    })),
  });
  const result = await api(
    owner,
    'GET',
    `/ledgers/${ledgerId}/member-stats?dimension=payer&scope=month&period=2026-09&tz_offset_minutes=480`,
  );
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json()).toMatchObject({
    scope: 'month',
    period: '2026-09',
    start_at: '2026-09-14T16:00:00.000Z',
    end_at: '2026-10-14T16:00:00.000Z',
    items: [expect.objectContaining({ member_id: participant.id, expense_total: '5', tx_count: 2 })],
  });
});

it('空账本付款视图为空且陌生账号与未知统计维度均被拒绝', async () => {
  const { owner, ledgerId } = await fixture();
  const empty = await api(owner, 'GET', `/ledgers/${ledgerId}/member-stats?dimension=payer&scope=all`);
  expect(empty.statusCode, empty.body).toBe(200);
  expect(empty.json().items).toEqual([]);
  const stranger = await register();
  const denied = await api(stranger, 'GET', `/ledgers/${ledgerId}/member-stats?dimension=payer&scope=all`);
  expect(denied.statusCode, denied.body).toBe(404);
  expect(denied.body).not.toContain('付款人汇总隐私账本');
  const invalid = await api(owner, 'GET', `/ledgers/${ledgerId}/member-stats?dimension=unknown`);
  expect(invalid.statusCode, invalid.body).toBe(400);
});
