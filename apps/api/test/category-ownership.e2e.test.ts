import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadTestApiConfig } from './test-api-config.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';

const prisma = new PrismaClient({ datasourceUrl: testFixtureDatabaseUrl() });
const app = buildApp({
  logger: false,
  prisma,
  config: { ...loadTestApiConfig(), authRateLimitMax: 1000, rateLimitMax: 1000 },
});
type Session = { access_token: string; device_id: string; user: { user_id: string } };
type Ledger = { id: string; owner_id: string };
const breakfastId = '02d2cbc5-0298-5dea-ae85-f4616e0eafc2';

beforeAll(() => app.ready());
afterAll(() => app.close());

/** 在显式测试库建立独立账号，分类身份与所有者由真实认证和账本创建接口生成。 */
async function register(): Promise<Session> {
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        country_code: '+86',
        phone: `138${randomInt(100000000).toString().padStart(8, '0')}`,
        password: 'category-ownership-password',
        device: { installation_id: randomUUID(), name: '分类归属验证', platform: 'test' },
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<Session>();
  } catch (error) {
    throw new Error('分类归属测试账号创建失败', { cause: error });
  }
}

/** 使用统一分类协议发起请求，HTTP 入口保持完整的授权和响应序列化。 */
async function call(session: Session, method: 'GET' | 'POST' | 'DELETE', path: string, payload?: object, key?: string) {
  try {
    return await app.inject({
      method,
      url: `/api/v1${path}`,
      headers: {
        authorization: `Bearer ${session.access_token}`,
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(payload ? { payload } : {}),
    });
  } catch (error) {
    throw new Error('分类归属测试请求失败', { cause: error });
  }
}

it('同UUID分类的共享增量与墓碑携带真实Owner，普通请求读取完整授权目录', async () => {
  try {
    const owner = await register();
    const viewer = await register();
    const ownLedger = await call(owner, 'POST', '/ledgers', { name: '共享分类归属', currency: 'CNY' });
    const privateLedger = await call(viewer, 'POST', '/ledgers', { name: '本人分类归属', currency: 'CNY' });
    expect(ownLedger.statusCode, ownLedger.body).toBe(201);
    expect(privateLedger.statusCode, privateLedger.body).toBe(201);
    const ledger = ownLedger.json<Ledger>();
    expect(ledger.owner_id).toBe(owner.user.user_id);
    const invitation = await call(owner, 'POST', `/ledgers/${ledger.id}/invites`, {});
    expect(invitation.statusCode, invitation.body).toBe(201);
    const joined = await call(viewer, 'POST', `/invites/${invitation.json<{ code: string }>().code}/accept`);
    expect(joined.statusCode, joined.body).toBe(200);

    const categories = await call(owner, 'GET', `/ledgers/${ledger.id}/categories`);
    const breakfast = categories
      .json<Array<{ id: string; owner_id: string; version_token: string }>>()
      .find((row) => row.id === breakfastId)!;
    expect(breakfast.owner_id).toBe(owner.user.user_id);
    const deleted = await call(
      owner,
      'DELETE',
      `/ledgers/${ledger.id}/categories/${breakfastId}?expected_version_token=${breakfast.version_token}`,
      undefined,
      randomUUID(),
    );
    expect(deleted.statusCode, deleted.body).toBe(204);

    // 真实领域写入已保存权威归属，定向投递只改变接收者而不改变事件事实。
    const event = await prisma.syncChange.findFirstOrThrow({
      where: { userId: owner.user.user_id, entityType: 'category', entityId: breakfastId, action: 'delete' },
      orderBy: { changeId: 'desc' },
    });
    expect(event.payload).toMatchObject({ owner_id: owner.user.user_id });
    await prisma.syncChange.update({
      where: { changeId: event.changeId },
      data: {
        recipientUserId: viewer.user.user_id,
      },
    });
    const aware = await call(viewer, 'GET', '/sync/pull?since=0&limit=1000');
    expect(aware.statusCode, aware.body).toBe(200);
    expect(
      aware.json().changes.find((row: { change_id: string }) => row.change_id === event.changeId.toString()).payload
        .owner_id,
    ).toBe(owner.user.user_id);
    expect(
      aware.json().changes.find((row: { change_id: string }) => row.change_id === event.changeId.toString()).payload,
    ).toEqual(event.payload);

    const account = await call(viewer, 'GET', '/sync/accounting/full');
    expect(account.statusCode, account.body).toBe(200);
    expect(account.json().category_tombstones).toContainEqual(
      expect.objectContaining({
        id: breakfastId,
        owner_id: owner.user.user_id,
        deleted_at: expect.any(String),
      }),
    );
    expect(account.json().categories).toContainEqual(
      expect.objectContaining({
        id: breakfastId,
        owner_id: viewer.user.user_id,
        deleted_at: null,
      }),
    );
    const full = await call(viewer, 'GET', `/sync/full?ledger_id=${ledger.id}`);
    expect(full.statusCode, full.body).toBe(200);
    expect(full.json().ledger.owner_id).toBe(owner.user.user_id);
    expect(full.json().categories.every((row: { owner_id: string }) => row.owner_id === owner.user.user_id)).toBe(true);
    expect(full.json().category_tombstones).toContainEqual(
      expect.objectContaining({ id: breakfastId, owner_id: owner.user.user_id }),
    );
  } catch (error) {
    throw new Error('分类归属隔离、共享能力和墓碑回归失败', { cause: error });
  }
});
