import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadTestApiConfig } from './test-api-config.js';

const DATABASE_URL = testFixtureDatabaseUrl();

type Session = { token: string; userId: string; deviceId: string };
type RequestOptions = { session?: Session; payload?: Record<string, unknown>; key?: string };

let prisma: PrismaClient;
let app: ReturnType<typeof buildApp>;
let owner: Session;
let editor: Session;

/** 发送真实 REST 请求，并让每次调用显式指定身份与幂等键。 */
async function api(method: 'POST' | 'PATCH' | 'DELETE', path: string, options: RequestOptions = {}) {
  try {
    return await app.inject({
      method,
      url: `/api/v1${path}`,
      headers: {
        ...(options.session ? { authorization: `Bearer ${options.session.token}` } : {}),
        ...(options.key ? { 'idempotency-key': options.key } : {}),
      },
      ...(options.payload ? { payload: options.payload } : {}),
    });
  } catch (error) {
    console.error('交易幂等测试请求失败', { method, path, error });
    throw error;
  }
}

/** 注册独立测试身份，避免依赖已有账号或固定手机号。 */
async function registerUser(): Promise<Session> {
  try {
    const response = await api('POST', '/auth/register', {
      payload: {
        country_code: '+86',
        phone: `139${randomInt(0, 100_000_000).toString().padStart(8, '0')}`,
        password: 'password-123456',
        device: { installation_id: randomUUID(), name: '交易幂等测试', platform: 'test' },
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const session = response.json<{ access_token: string; device_id: string; user: { user_id: string } }>();
    return { token: session.access_token, userId: session.user.user_id, deviceId: session.device_id };
  } catch (error) {
    console.error('交易幂等测试账号创建失败', error);
    throw error;
  }
}

beforeAll(async () => {
  try {
    prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
    app = buildApp({
      logger: false,
      prisma,
      config: {
        ...loadTestApiConfig(),
        databaseUrl: DATABASE_URL,
        storagePath: resolve(import.meta.dirname, '../../../Temp/transaction-idempotency'),
        rateLimitMax: 1000,
        authRateLimitMax: 1000,
      },
    });
    await app.ready();
    owner = await registerUser();
    editor = await registerUser();
  } catch (error) {
    console.error('交易幂等测试初始化失败', error);
    throw error;
  }
});

afterAll(async () => {
  try {
    if (app) await app.close();
    else if (prisma) await prisma.$disconnect();
  } catch (error) {
    console.error('交易幂等测试连接清理失败', error);
    throw error;
  }
});

/** 建立包含分类、周期模板和分摊的已成功交易，保存首次响应供后续精确重放比较。 */
async function createFixture(creator: Session = owner) {
  try {
    const ledgerId = randomUUID();
    const ledger = await api('POST', '/ledgers', {
      session: owner,
      payload: { id: ledgerId, name: '交易幂等账本', currency: 'CNY', aa_enabled: true },
    });
    expect(ledger.statusCode, ledger.body).toBe(201);
    if (creator.userId !== owner.userId) {
      const invite = await api('POST', `/ledgers/${ledgerId}/invites`, { session: owner, payload: {} });
      expect(invite.statusCode, invite.body).toBe(201);
      const accepted = await api('POST', `/invites/${invite.json<{ code: string }>().code}/accept`, {
        session: creator,
        payload: {},
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
    }
    const member = await prisma.ledgerMember.findFirstOrThrow({
      where: { ledgerId, linkedAccountId: creator.userId },
    });
    const categoryId = randomUUID();
    const category = await api('POST', `/ledgers/${ledgerId}/categories`, {
      session: owner,
      payload: { id: categoryId, name: `幂等分类-${categoryId}`, kind: 'expense', level: 1 },
    });
    expect(category.statusCode, category.body).toBe(201);
    const body = {
      id: randomUUID(),
      tx_type: 'expense',
      amount: '10',
      native_amount: '70',
      currency_code: 'USD',
      happened_at: '2026-09-27T00:00:00.000Z',
      note: '首次成功的交易',
      category_id: categoryId,
      aa_mode: '2',
      splits: [{ member_id: member.id, amount: '70' }],
    };
    const path = `/ledgers/${ledgerId}/transactions`;
    const key = randomUUID();
    const created = await api('POST', path, { session: creator, key, payload: body });
    expect(created.statusCode, created.body).toBe(201);
    return {
      ledgerId,
      categoryId,
      syncId: ledger.json<{ sync_id: string }>().sync_id,
      memberId: member.id,
      creator,
      path,
      key,
      body,
      originalResponse: created.json(),
    };
  } catch (error) {
    console.error('交易幂等测试数据创建失败', error);
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

/** 记录完整交易、分摊、历史、同步事件及幂等缓存，检查重放与拒绝均没有额外写入。 */
async function readState(fixture: Fixture) {
  try {
    const [transactions, changes, keys] = await Promise.all([
      prisma.transaction.findMany({
        where: { ledgerId: fixture.ledgerId },
        include: { splits: { orderBy: { memberId: 'asc' } }, editHistory: { orderBy: { version: 'asc' } } },
        orderBy: { id: 'asc' },
      }),
      prisma.syncChange.findMany({ where: { ledgerId: fixture.ledgerId }, orderBy: { changeId: 'asc' } }),
      prisma.idempotencyKey.findMany({ where: { userId: fixture.creator.userId }, orderBy: { id: 'asc' } }),
    ]);
    return { transactions, changes, keys };
  } catch (error) {
    console.error('交易幂等测试状态读取失败', { ledgerId: fixture.ledgerId, error });
    throw error;
  }
}

describe('交易创建的幂等重放与当前授权', () => {
  it.each([
    { change: '分类软删除', code: 'INVALID_CATEGORY' },
    { change: '账本币种变化', code: 'INVALID_NATIVE_AMOUNT' },
  ])('$change 后同键重放首次响应，新键仍按当前规则拒绝', async ({ change, code }) => {
    try {
      const fixture = await createFixture();
      if (change === '分类软删除') {
        // 本用例验证已保存回执与后续云态的关系，直接构造历史分类墓碑。
        await prisma.category.update({
          where: { id_ownerId: { id: fixture.categoryId, ownerId: owner.userId } },
          data: { deletedAt: new Date() },
        });
      } else {
        const changed = await api('PATCH', `/ledgers/${fixture.ledgerId}`, {
          session: owner,
          payload: { currency: 'USD' },
        });
        expect(changed.statusCode, changed.body).toBe(200);
      }
      const before = await readState(fixture);
      const replay = await api('POST', fixture.path, { session: owner, key: fixture.key, payload: fixture.body });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toEqual(fixture.originalResponse);
      expect(await readState(fixture)).toEqual(before);

      const fresh = await api('POST', fixture.path, {
        session: owner,
        key: randomUUID(),
        payload: { ...fixture.body, id: randomUUID() },
      });
      expect(fresh.statusCode, fresh.body).toBe(400);
      expect(fresh.json()).toMatchObject({ code });
      expect(await readState(fixture)).toEqual(before);

      const reused = await api('POST', fixture.path, {
        session: owner,
        key: fixture.key,
        payload: { ...fixture.body, note: '不同请求' },
      });
      expect(reused.statusCode, reused.body).toBe(409);
      expect(reused.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      expect(await readState(fixture)).toEqual(before);
    } catch (error) {
      console.error('交易幂等重放与当前校验回归失败', { change, error });
      throw error;
    }
  });

  it('Editor 被移除后不能通过旧幂等键读取成功响应', async () => {
    try {
      const fixture = await createFixture(editor);
      const removed = await api('DELETE', `/ledgers/${fixture.ledgerId}/members/${fixture.memberId}`, {
        session: owner,
      });
      expect(removed.statusCode, removed.body).toBe(204);
      const before = await readState(fixture);
      const replay = await api('POST', fixture.path, { session: editor, key: fixture.key, payload: fixture.body });
      expect(replay.statusCode, replay.body).toBe(404);
      expect(replay.json()).toMatchObject({ code: 'LEDGER_NOT_FOUND' });
      expect(replay.body).not.toContain(fixture.body.note);
      expect(await readState(fixture)).toEqual(before);
    } catch (error) {
      console.error('交易幂等重放的撤权回归失败', error);
      throw error;
    }
  });
});
