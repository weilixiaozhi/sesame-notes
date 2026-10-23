import { randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';

const databaseUrl = testFixtureDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = buildApp({
  logger: false,
  prisma,
  config: {
    ...loadConfig({
      DATABASE_URL: databaseUrl,
      JWT_SECRET: 'ledger-clear-test-secret-at-least-32-bytes',
      STORAGE_PATH: process.env.STORAGE_PATH ?? resolve(import.meta.dirname, '../../../Temp/ledger-clear'),
    }),
    authRateLimitMax: 1000,
    rateLimitMax: 1000,
  },
});
type Session = { access_token: string; device_id: string; user: { user_id: string } };
type Ledger = { id: string; sync_id: string };
beforeAll(() => app.ready());
afterAll(() => app.close());

/** 所有业务调用只使用当前测试注册的账号，绝不读取生产凭证。 */
function api(session: Session, method: 'GET' | 'POST' | 'PATCH', path: string, payload?: object) {
  return app.inject({
    method,
    url: `/api/v1${path}`,
    headers: { authorization: `Bearer ${session.access_token}` },
    ...(payload ? { payload } : {}),
  });
}
/** 每次创建独立测试账号与账本。 */
async function account() {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      country_code: '+86',
      phone: `138${randomInt(100000000).toString().padStart(8, '0')}`,
      password: 'clear-ledger-test',
      device: { installation_id: randomUUID(), name: '账本清空测试', platform: 'test' },
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  const session = response.json<Session>();
  const created = await api(session, 'POST', '/ledgers', { name: '仅隔离测试账本', currency: 'CNY' });
  expect(created.statusCode, created.body).toBe(201);
  return { session, ledger: created.json<Ledger>() };
}
/** 批量建立超过页面容量的夹具，验证清空范围不受前端分页影响。 */
async function transactions(session: Session, ledger: Ledger, count: number) {
  const ids = Array.from({ length: count }, () => randomUUID()).sort();
  await prisma.transaction.createMany({
    data: ids.map((id) => ({
      id,
      ledgerId: ledger.id,
      ownerId: session.user.user_id,
      txType: 'expense',
      amount: '9007199254740993.1234567890',
      nativeAmount: '9007199254740993.1234567890',
      currencyCode: 'CNY',
      happenedAt: new Date('2026-09-30T08:00:00Z'),
    })),
  });
  return ids;
}
/** 固定一次真实服务端预览，后续修改不得悄悄扩大这次确认。 */
async function confirmation(session: Session, ledger: Ledger) {
  const response = await api(session, 'GET', `/ledgers/${ledger.id}/action-preview`);
  expect(response.statusCode, response.body).toBe(200);
  const preview = response.json<{ sync_id: string; fingerprint: string; transaction_count: number }>();
  return { mutation_id: randomUUID(), expected_sync_id: preview.sync_id, expected_fingerprint: preview.fingerprint };
}

/** 清空仅删除交易，规则继续保留，与手机语义一致。 */
async function recurring(session: Session, ledger: Ledger) {
  return prisma.recurringTransaction.create({
    data: {
      ledgerId: ledger.id,
      ownerId: session.user.user_id,
      txType: 'expense',
      amount: '1',
      currencyCode: 'CNY',
      frequency: 'monthly',
      startDate: new Date('2026-09-01T00:00:00Z'),
      dayOfMonth: 1,
    },
  });
}

describe('账本清空原子命令', () => {
  it('删除全部205条活跃交易并生成逐条同步墓碑，保留其他账本、历史、分类、周期规则、成员和同步代次', async () => {
    const { session, ledger } = await account();
    const ids = await transactions(session, ledger, 205);
    const rule = await recurring(session, ledger);
    const categoryResponse = await api(session, 'POST', `/ledgers/${ledger.id}/categories`, {
      name: '保留分类',
      kind: 'expense',
      level: 1,
      sort_order: 0,
    });
    expect(categoryResponse.statusCode, categoryResponse.body).toBe(201);
    const categoryId = categoryResponse.json<{ id: string }>().id;
    const otherLedger = (await api(session, 'POST', '/ledgers', { name: '另一本' })).json<Ledger>();
    const otherIds = await transactions(session, otherLedger, 1);
    const deletedId = randomUUID();
    await prisma.transaction.create({
      data: {
        id: deletedId,
        ledgerId: ledger.id,
        ownerId: session.user.user_id,
        txType: 'expense',
        amount: '1',
        nativeAmount: '1',
        currencyCode: 'CNY',
        happenedAt: new Date(),
        deletedAt: new Date(),
        revision: 3,
      },
    });
    const members = await prisma.ledgerMember.findMany({ where: { ledgerId: ledger.id } });
    const body = await confirmation(session, ledger);
    const cursor = (await prisma.syncChange.aggregate({ _max: { changeId: true } }))._max.changeId ?? 0n;
    const response = await api(session, 'POST', `/ledgers/${ledger.id}/clear`, body);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ deleted_count: 205, sync_id: ledger.sync_id, replayed: false });
    const remaining = await prisma.transaction.count({ where: { ledgerId: ledger.id, deletedAt: null } });
    expect(remaining).toBe(0);
    expect(await prisma.transaction.count({ where: { id: { in: ids }, deletedAt: { not: null }, revision: 2 } })).toBe(
      205,
    );
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: deletedId } })).revision).toBe(3);
    expect(await prisma.transactionEditHistory.count({ where: { ledgerId: ledger.id, version: 2 } })).toBe(205);
    expect(
      await prisma.syncChange.count({ where: { ledgerId: ledger.id, entityType: 'transaction', action: 'delete' } }),
    ).toBe(205);
    const pulled = await api(session, 'GET', `/sync/pull?since=${cursor}&limit=1000`);
    expect(pulled.statusCode, pulled.body).toBe(200);
    expect(
      pulled
        .json<{ changes: Array<{ entity_type: string; action: string }> }>()
        .changes.filter((row) => row.entity_type === 'transaction' && row.action === 'delete'),
    ).toHaveLength(205);
    expect((await prisma.ledger.findUniqueOrThrow({ where: { id: ledger.id } })).syncId).toBe(ledger.sync_id);
    expect(await prisma.recurringTransaction.findUniqueOrThrow({ where: { id: rule.id } })).toEqual(rule);
    expect(
      (
        await prisma.category.findUniqueOrThrow({
          where: { id_ownerId: { id: categoryId, ownerId: session.user.user_id } },
        })
      ).deletedAt,
    ).toBeNull();
    expect(await prisma.ledgerMember.findMany({ where: { ledgerId: ledger.id } })).toEqual(members);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: otherIds[0]! } })).deletedAt).toBeNull();
  }, 20000);

  it('响应丢失后重试只重放回执，不删除后来新增交易；同键改正文拒绝', async () => {
    const { session, ledger } = await account();
    await transactions(session, ledger, 2);
    const body = await confirmation(session, ledger);
    expect((await api(session, 'POST', `/ledgers/${ledger.id}/clear`, body)).statusCode).toBe(200);
    const newIds = await transactions(session, ledger, 1);
    const count = await prisma.syncChange.count({ where: { ledgerId: ledger.id } });
    const replay = await api(session, 'POST', `/ledgers/${ledger.id}/clear`, body);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual({ deleted_count: 2, sync_id: ledger.sync_id, replayed: true });
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: newIds[0]! } })).deletedAt).toBeNull();
    expect(await prisma.syncChange.count({ where: { ledgerId: ledger.id } })).toBe(count);
    const changed = await api(session, 'POST', `/ledgers/${ledger.id}/clear`, {
      ...body,
      expected_fingerprint: '0'.repeat(64),
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it.each(['新增交易', '修改交易', '修改账本', '新增周期规则'])(
    '确认后%s使旧预览失效，所有交易保持原样',
    async (kind) => {
      const { session, ledger } = await account();
      const ids = await transactions(session, ledger, 2);
      const body = await confirmation(session, ledger);
      if (kind === '新增交易') await transactions(session, ledger, 1);
      if (kind === '修改交易')
        await prisma.transaction.update({
          where: { id: ids[0]! },
          data: { revision: { increment: 1 }, note: '另端修改' },
        });
      if (kind === '修改账本') await api(session, 'PATCH', `/ledgers/${ledger.id}`, { name: '另端更名' });
      if (kind === '新增周期规则') await recurring(session, ledger);
      const response = await api(session, 'POST', `/ledgers/${ledger.id}/clear`, body);
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe('LEDGER_PREVIEW_CHANGED');
      expect(await prisma.transaction.count({ where: { ledgerId: ledger.id, deletedAt: { not: null } } })).toBe(0);
      expect(
        await prisma.idempotencyKey.count({
          where: { userId: session.user.user_id, key: `ledger-clear:${ledger.id}:${body.mutation_id}` },
        }),
      ).toBe(0);
    },
  );

  it('编辑者和陌生人不能清空，当前账号归档后必须先恢复，重建身份拒绝', async () => {
    const { session, ledger } = await account();
    const editor = (await account()).session;
    const stranger = (await account()).session;
    await transactions(session, ledger, 2);
    const invite = await api(session, 'POST', `/ledgers/${ledger.id}/invites`, { role: 'editor' });
    expect(invite.statusCode, invite.body).toBe(201);
    expect((await api(editor, 'POST', `/invites/${invite.json().code}/accept`, {})).statusCode).toBe(200);
    const body = await confirmation(session, ledger);
    expect((await api(editor, 'POST', `/ledgers/${ledger.id}/clear`, body)).statusCode).toBe(403);
    expect((await api(stranger, 'POST', `/ledgers/${ledger.id}/clear`, body)).statusCode).toBe(404);
    expect(
      (await api(session, 'POST', `/ledgers/${ledger.id}/clear`, { ...body, expected_sync_id: randomUUID() }))
        .statusCode,
    ).toBe(412);
    await prisma.ledgerMember.update({
      where: { ledgerId_linkedAccountId: { ledgerId: ledger.id, linkedAccountId: session.user.user_id } },
      data: { archivedAt: new Date(), archiveUpdatedAt: new Date() },
    });
    const archived = await api(session, 'POST', `/ledgers/${ledger.id}/clear`, body);
    expect(archived.statusCode).toBe(409);
    expect(archived.json().code).toBe('LEDGER_ARCHIVED');
    expect(await prisma.transaction.count({ where: { ledgerId: ledger.id, deletedAt: null } })).toBe(2);
  });

  it('中途写历史发生数据库冲突时，先前交易与同步事件也完整回滚', async () => {
    const { session, ledger } = await account();
    const ids = await transactions(session, ledger, 2);
    // 故意设置第二条的未来历史版本，使真实数据库唯一约束在第一条写入后触发回滚。
    await prisma.transactionEditHistory.create({
      data: { transactionId: ids[1]!, ledgerId: ledger.id, version: 2, changes: { test_only: true } },
    });
    const body = await confirmation(session, ledger);
    const response = await api(session, 'POST', `/ledgers/${ledger.id}/clear`, body);
    expect(response.statusCode).toBe(500);
    expect(await prisma.transaction.count({ where: { ledgerId: ledger.id, deletedAt: null, revision: 1 } })).toBe(2);
    expect(await prisma.syncChange.count({ where: { ledgerId: ledger.id, action: 'delete' } })).toBe(0);
    expect(await prisma.transactionEditHistory.count({ where: { transactionId: ids[0] } })).toBe(0);
    expect(
      await prisma.idempotencyKey.count({
        where: { userId: session.user.user_id, key: `ledger-clear:${ledger.id}:${body.mutation_id}` },
      }),
    ).toBe(0);
  });

  it('空账本成功也保留幂等回执；缺失确认或匿名请求不能执行', async () => {
    const { session, ledger } = await account();
    const body = await confirmation(session, ledger);
    expect((await api(session, 'POST', `/ledgers/${ledger.id}/clear`, {})).statusCode).toBe(400);
    const anonymous = await app.inject({ method: 'POST', url: `/api/v1/ledgers/${ledger.id}/clear`, payload: body });
    expect(anonymous.statusCode).toBe(401);
    const response = await api(session, 'POST', `/ledgers/${ledger.id}/clear`, body);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ deleted_count: 0, sync_id: ledger.sync_id, replayed: false });
    await transactions(session, ledger, 1);
    expect((await api(session, 'POST', `/ledgers/${ledger.id}/clear`, body)).json().replayed).toBe(true);
    expect(await prisma.transaction.count({ where: { ledgerId: ledger.id, deletedAt: null } })).toBe(1);
  });
});
