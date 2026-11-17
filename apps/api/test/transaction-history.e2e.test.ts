import { randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { jwtVerify, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { loadTestApiConfig } from './test-api-config.js';

const databaseUrl = testFixtureDatabaseUrl();
const preciseAmount = '9007199254740993.1234567891';
let prisma: PrismaClient;
let app: ReturnType<typeof buildApp>;
let config: ReturnType<typeof loadTestApiConfig>;
type Actor = { token: string; userId: string; deviceId: string };
type Fixture = { ledgerId: string; transactionId: string; memberId: string };
type HistoryItem = {
  id: string;
  transaction_id: string;
  ledger_id: string;
  version: number;
  operator_member_id: string | null;
  operator_display_name: string | null;
  created_at: string;
  changes: unknown;
};
type HistoryPage = { items: HistoryItem[]; next_cursor: string | null };
let owner: Actor;
let editor: Actor;
let outsider: Actor;

/** 发送真实路由请求，身份与请求体均由用例显式指定。 */
async function request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, actor?: Actor, payload?: object) {
  try {
    return await app.inject({
      method,
      url: `/api/v1${path}`,
      headers: actor ? { authorization: `Bearer ${actor.token}` } : {},
      ...(payload === undefined ? {} : { payload }),
    });
  } catch (cause) {
    throw new Error(`历史路由测试请求失败：${method} ${path}`, { cause });
  }
}

/** 为用例注册真实凭据，确保只读 scope 与撤销检查走实际鉴权。 */
async function register(): Promise<Actor> {
  try {
    const response = await request('POST', '/auth/register', undefined, {
      country_code: '+86',
      phone: `139${randomInt(0, 100_000_000).toString().padStart(8, '0')}`,
      password: 'history-test-password',
      device: { installation_id: randomUUID(), name: '历史查询测试', platform: 'test' },
    });
    expect(response.statusCode, response.body).toBe(201);
    const token = response.json<{ access_token: string }>().access_token;
    const { payload } = await jwtVerify(token, new TextEncoder().encode(config.jwtSecret));
    if (typeof payload.sub !== 'string' || typeof payload.device_id !== 'string') throw new Error('认证响应身份缺失');
    return { token, userId: payload.sub, deviceId: payload.device_id };
  } catch (cause) {
    throw new Error('历史路由测试账号初始化失败', { cause });
  }
}

/** 每个用例独占账本和交易，随机顺序不会复用历史版本或授权状态。 */
async function fixture(actor = owner): Promise<Fixture> {
  try {
    const ledgerId = randomUUID();
    const created = await request('POST', '/ledgers', actor, {
      id: ledgerId,
      name: '历史读取账本',
      currency: 'CNY',
      aa_enabled: true,
    });
    expect(created.statusCode, created.body).toBe(201);
    const member = await prisma.ledgerMember.findFirstOrThrow({ where: { ledgerId, linkedAccountId: actor.userId } });
    await prisma.ledgerMember.update({ where: { id: member.id }, data: { displayName: '账本操作成员' } });
    const transactionId = randomUUID();
    const transaction = await request('POST', `/ledgers/${ledgerId}/transactions`, actor, {
      id: transactionId,
      tx_type: 'expense',
      amount: '100',
      native_amount: '100',
      currency_code: 'CNY',
      happened_at: '2026-11-03T00:00:00.000Z',
      aa_mode: '0',
      splits: [],
    });
    expect(transaction.statusCode, transaction.body).toBe(201);
    return { ledgerId, transactionId, memberId: member.id };
  } catch (cause) {
    throw new Error('历史路由业务夹具初始化失败', { cause });
  }
}

/** 更新通过正式 mutation core 产生真实历史，不在查询测试里伪造历史响应。 */
async function patch(value: Fixture, revision: number, body: object, actor = owner) {
  const response = await request('PATCH', `/ledgers/${value.ledgerId}/transactions/${value.transactionId}`, actor, {
    base_revision: revision,
    ...body,
  });
  expect(response.statusCode, response.body).toBe(200);
}

/** 通过正式邀请流程成为当前账本编辑成员。 */
async function join(value: Fixture, actor = editor): Promise<string> {
  try {
    const invite = await request('POST', `/ledgers/${value.ledgerId}/invites`, owner, {});
    expect(invite.statusCode, invite.body).toBe(201);
    const accepted = await request('POST', `/invites/${invite.json<{ code: string }>().code}/accept`, actor, {});
    expect(accepted.statusCode, accepted.body).toBe(200);
    const member = await prisma.ledgerMember.findFirstOrThrow({
      where: { ledgerId: value.ledgerId, linkedAccountId: actor.userId },
    });
    return member.id;
  } catch (cause) {
    throw new Error('历史路由共享成员夹具失败', { cause });
  }
}

/** 查询路径绑定账本与交易，游标只按服务端返回值透传。 */
function historyPath(value: Fixture, query = ''): string {
  return `/ledgers/${value.ledgerId}/transactions/${value.transactionId}/history${query}`;
}

/** 批量路径把交易集合编码为单个查询参数，服务端负责校验、去重和排序。 */
function batchHistoryPath(value: Fixture, transactionIds: readonly string[], query = ''): string {
  return `/ledgers/${value.ledgerId}/transactions/history?transaction_ids=${encodeURIComponent(
    transactionIds.join(','),
  )}${query}`;
}

/** 同一账本追加第二笔交易，批量接口必须只返回请求集合内的历史。 */
async function createSecondTransaction(value: Fixture, actor = owner): Promise<string> {
  const transactionId = randomUUID();
  const response = await request('POST', `/ledgers/${value.ledgerId}/transactions`, actor, {
    id: transactionId,
    tx_type: 'expense',
    amount: '20',
    native_amount: '20',
    currency_code: 'CNY',
    happened_at: '2026-11-04T00:00:00.000Z',
    aa_mode: '0',
    splits: [],
  });
  expect(response.statusCode, response.body).toBe(201);
  return transactionId;
}

beforeAll(async () => {
  try {
    prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    config = {
      ...loadTestApiConfig(),
      databaseUrl,
      storagePath: resolve(import.meta.dirname, '../../../Temp/cloud-history-api/storage'),
      rateLimitMax: 5000,
      authRateLimitMax: 5000,
    };
    app = buildApp({ logger: false, prisma, config });
    await app.ready();
    owner = await register();
    editor = await register();
    outsider = await register();
  } catch (cause) {
    throw new Error('历史查询测试初始化失败', { cause });
  }
});

afterAll(async () => {
  try {
    if (app) await app.close();
    else await prisma?.$disconnect();
  } catch (cause) {
    throw new Error('历史查询测试关闭失败', { cause });
  }
});

describe('云端交易编辑历史', () => {
  it('无编辑时为空，真实编辑原JSON与大额小数精度、成员身份完整返回，读取没有业务写入', async () => {
    const value = await fixture();
    const initial = await request('GET', historyPath(value), owner);
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json()).toEqual({ items: [], next_cursor: null });
    const changes = { amount: preciseAmount, native_amount: preciseAmount, note: null, base_revision: 1 };
    await patch(value, 1, changes);
    const before = await prisma.transaction.findUniqueOrThrow({
      where: { id: value.transactionId },
      include: { editHistory: true },
    });
    const events = await prisma.syncChange.count({ where: { ledgerId: value.ledgerId } });
    const response = await request('GET', historyPath(value), owner);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const page = response.json<HistoryPage>();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toEqual({
      id: before.editHistory[0]!.id,
      transaction_id: value.transactionId,
      ledger_id: value.ledgerId,
      version: 2,
      operator_member_id: value.memberId,
      operator_display_name: '账本操作成员',
      created_at: before.editHistory[0]!.createdAt.toISOString(),
      // 历史以事务实际保存的变更为准，输入校验规范化不由读取接口反向改写。
      changes: before.editHistory[0]!.changes,
    });
    expect((page.items[0]!.changes as Record<string, unknown>).amount).toBe(preciseAmount);
    expect(Object.keys(page.items[0]!).sort()).toEqual(
      [
        'id',
        'transaction_id',
        'ledger_id',
        'version',
        'operator_member_id',
        'operator_display_name',
        'created_at',
        'changes',
      ].sort(),
    );
    expect(page.next_cursor).toBeNull();
    expect(
      await prisma.transaction.findUniqueOrThrow({
        where: { id: value.transactionId },
        include: { editHistory: true },
      }),
    ).toEqual(before);
    expect(await prisma.syncChange.count({ where: { ledgerId: value.ledgerId } })).toBe(events);
  });

  it('唯一历史版本倒序分页，同时间及翻页期间新增编辑不产生重复或漏掉已有版本', async () => {
    const value = await fixture();
    for (let version = 1; version <= 3; version++) await patch(value, version, { note: `编辑${version}` });
    await prisma.transactionEditHistory.updateMany({
      where: { transactionId: value.transactionId },
      data: { createdAt: new Date('2026-11-03T00:00:00Z') },
    });
    const first = await request('GET', historyPath(value, '?limit=1'), owner);
    expect(first.statusCode, first.body).toBe(200);
    let page = first.json<HistoryPage>();
    expect(page.items.map((item) => item.version)).toEqual([4]);
    await patch(value, 4, { note: '翻页期间新增' });
    const versions = [4];
    while (page.next_cursor) {
      const next = await request(
        'GET',
        historyPath(value, `?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`),
        owner,
      );
      expect(next.statusCode, next.body).toBe(200);
      page = next.json<HistoryPage>();
      versions.push(...page.items.map((item) => item.version));
      expect(versions.length).toBeLessThanOrEqual(3);
    }
    expect(versions).toEqual([4, 3, 2]);
    expect(
      (await request('GET', historyPath(value), owner)).json<HistoryPage>().items.map((item) => item.version),
    ).toEqual([5, 4, 3, 2]);
  });

  it('只读scope可查询，无scope、未登录和其他账号拒绝访问', async () => {
    const value = await fixture();
    const key = new TextEncoder().encode(config.jwtSecret);
    const { payload } = await jwtVerify(owner.token, key);
    const reader = {
      ...owner,
      token: await new SignJWT({ ...payload, scopes: ['sync:read'] })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .sign(key),
    };
    const denied = {
      ...owner,
      token: await new SignJWT({ ...payload, scopes: ['sync:write'] })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .sign(key),
    };
    expect((await request('GET', historyPath(value), reader)).statusCode).toBe(200);
    expect((await request('GET', historyPath(value), denied)).statusCode).toBe(403);
    expect((await request('GET', historyPath(value))).statusCode).toBe(401);
    expect((await request('GET', historyPath(value), outsider)).statusCode).toBe(404);
  });

  it('共享成员可读，离开或移除后不能读；退出操作者的历史身份仍对其他授权成员保留', async () => {
    const value = await fixture();
    const memberId = await join(value);
    await prisma.ledgerMember.update({ where: { id: memberId }, data: { displayName: '已退出编辑成员' } });
    await patch(value, 1, { note: '成员编辑' }, editor);
    expect((await request('GET', historyPath(value), editor)).statusCode).toBe(200);
    for (const status of ['LEFT', 'REMOVED'] as const) {
      await prisma.ledgerMember.update({ where: { id: memberId }, data: { status } });
      expect((await request('GET', historyPath(value), editor)).statusCode).toBe(404);
      const visible = await request('GET', historyPath(value), owner);
      expect(visible.statusCode, visible.body).toBe(200);
      expect(visible.json<HistoryPage>().items[0]).toMatchObject({
        operator_member_id: memberId,
        operator_display_name: '已退出编辑成员',
      });
    }
  });

  it('历史展示快照包含分类、金额、时间及备注/分摊变化标记', async () => {
    const value = await fixture();
    const categoryId = randomUUID();
    await prisma.category.create({
      data: { id: categoryId, ownerId: owner.userId, name: '餐饮', kind: 'expense' },
    });
    await patch(value, 1, {
      amount: '88',
      native_amount: '88',
      category_id: categoryId,
      note: '午餐',
    });
    let item = (await request('GET', historyPath(value), owner)).json<HistoryPage>().items[0]!;
    expect(item.changes).toMatchObject({
      display: {
        action: 'edit',
        category_name: '餐饮',
        amount: '88',
        currency_code: 'CNY',
        happened_at: '2026-11-03T00:00:00.000Z',
        note: '午餐',
        note_changed: true,
        sharing_changed: false,
      },
    });

    await patch(value, 2, {
      payer_member_id: value.memberId,
      aa_mode: '2',
      splits: [{ member_id: value.memberId, amount: '88' }],
    });
    item = (await request('GET', historyPath(value), owner)).json<HistoryPage>().items[0]!;
    expect(item.changes).toMatchObject({
      display: {
        action: 'edit',
        category_name: '餐饮',
        note_changed: false,
        sharing_changed: true,
      },
    });
  });

  it('软删除交易保留删除动作，归档成员仍可读取，删除账本后不可读取', async () => {
    const value = await fixture();
    const deleted = await request('DELETE', `/ledgers/${value.ledgerId}/transactions/${value.transactionId}`, owner, {
      base_revision: 1,
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    await prisma.ledgerMember.update({ where: { id: value.memberId }, data: { archivedAt: new Date() } });
    const response = await request('GET', historyPath(value), owner);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<HistoryPage>().items[0]!.changes).toEqual({
      action: 'delete',
      base_revision: 1,
      display: {
        action: 'delete',
        category_name: null,
        amount: '100',
        currency_code: 'CNY',
        happened_at: '2026-11-03T00:00:00.000Z',
        note: null,
        note_changed: false,
        sharing_changed: false,
      },
    });
    await prisma.ledger.update({ where: { id: value.ledgerId }, data: { deletedAt: new Date() } });
    expect((await request('GET', historyPath(value), owner)).statusCode).toBe(404);
  });
});

describe('云端批量交易编辑历史', () => {
  it('只返回请求集合内的历史，并按发生时间倒序分页', async () => {
    const value = await fixture();
    const second = await createSecondTransaction(value);
    await patch(value, 1, { note: '第一笔编辑' });
    await patch({ ...value, transactionId: second }, 1, { note: '第二笔编辑' });
    await patch(value, 2, { note: '第一笔再次编辑' });

    const response = await request('GET', batchHistoryPath(value, [value.transactionId, second]), owner);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const items = response.json<HistoryPage>().items;
    expect(items.filter((item) => item.transaction_id === value.transactionId).map((item) => item.version)).toEqual([
      3, 2,
    ]);
    expect(items.filter((item) => item.transaction_id === second).map((item) => item.version)).toEqual([2]);
    expect(items.map((item) => item.ledger_id)).toEqual([value.ledgerId, value.ledgerId, value.ledgerId]);
    expect(items[0]!.operator_display_name).toBe('账本操作成员');

    const onlySecond = await request('GET', batchHistoryPath(value, [second]), owner);
    expect(onlySecond.statusCode, onlySecond.body).toBe(200);
    expect(onlySecond.json<HistoryPage>().items.every((item) => item.transaction_id === second)).toBe(true);
  });

  it('分页不重复不遗漏，批量游标只对同一交易集合有效', async () => {
    const value = await fixture();
    const second = await createSecondTransaction(value);
    for (let revision = 1; revision <= 3; revision++) {
      await patch(value, revision, { note: `第一笔编辑${revision}` });
      await patch({ ...value, transactionId: second }, revision, { note: `第二笔编辑${revision}` });
    }
    // 同一时刻的历史行按 id 稳定排序，验证跨页游标不会重复或漏项。
    await prisma.transactionEditHistory.updateMany({
      where: { ledgerId: value.ledgerId },
      data: { createdAt: new Date('2026-11-03T00:00:00.000Z') },
    });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const response = await request(
        'GET',
        batchHistoryPath(
          value,
          [value.transactionId, second],
          `&limit=1${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
        ),
        owner,
      );
      expect(response.statusCode, response.body).toBe(200);
      const page = response.json<HistoryPage>();
      expect(page.items.length).toBeLessThanOrEqual(1);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.next_cursor;
      pages++;
      expect(pages).toBeLessThanOrEqual(6);
    } while (cursor !== null);
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);

    const first = await request('GET', batchHistoryPath(value, [value.transactionId, second], '&limit=1'), owner);
    expect(first.statusCode, first.body).toBe(200);
    const firstCursor = first.json<HistoryPage>().next_cursor;
    expect(firstCursor).not.toBeNull();
    // 游标是客户端原样透传的短字符串，契约上限 256 字符。
    expect(firstCursor!.length).toBeLessThanOrEqual(256);
    expect(
      (
        await request(
          'GET',
          batchHistoryPath(value, [value.transactionId], `&limit=1&cursor=${encodeURIComponent(firstCursor!)}`),
          owner,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (await request('GET', batchHistoryPath(value, [value.transactionId], '&limit=1&cursor=not-a-cursor'), owner))
        .statusCode,
    ).toBe(400);
  });

  it('批量参数、权限和账本边界一致拒绝', async () => {
    const value = await fixture();
    const second = await createSecondTransaction(value);
    expect((await request('GET', `/ledgers/${value.ledgerId}/transactions/history`, owner)).statusCode).toBe(400);
    expect((await request('GET', batchHistoryPath(value, ['not-a-valid-transaction-id']), owner)).statusCode).toBe(400);
    expect(
      (await request('GET', batchHistoryPath(value, [value.transactionId, value.transactionId]), owner)).statusCode,
    ).toBe(400);
    expect(
      (
        await request(
          'GET',
          batchHistoryPath(
            value,
            Array.from({ length: 101 }, () => randomUUID()),
          ),
          owner,
        )
      ).statusCode,
    ).toBe(400);

    const key = new TextEncoder().encode(config.jwtSecret);
    const { payload } = await jwtVerify(owner.token, key);
    const reader = {
      ...owner,
      token: await new SignJWT({ ...payload, scopes: ['sync:read'] }).setProtectedHeader({ alg: 'HS256' }).sign(key),
    };
    const denied = {
      ...owner,
      token: await new SignJWT({ ...payload, scopes: ['sync:write'] }).setProtectedHeader({ alg: 'HS256' }).sign(key),
    };
    expect((await request('GET', batchHistoryPath(value, [value.transactionId, second]), reader)).statusCode).toBe(200);
    expect((await request('GET', batchHistoryPath(value, [value.transactionId]), denied)).statusCode).toBe(403);
    expect((await request('GET', batchHistoryPath(value, [value.transactionId]))).statusCode).toBe(401);
    expect((await request('GET', batchHistoryPath(value, [value.transactionId]), outsider)).statusCode).toBe(404);
  });
});
