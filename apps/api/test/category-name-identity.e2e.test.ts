import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadTestApiConfig } from './test-api-config.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { accountingRequestFixturePath } from './accounting-request-fixture.js';
import { testStoragePath } from './test-storage-path.js';

type Session = { access_token: string; device_id: string; user: { user_id: string } };
type Owner = { session: Session; phone: string; password: string; ledgerId: string };
const prisma = new PrismaClient({ datasourceUrl: testFixtureDatabaseUrl() });
const app = buildApp({
  logger: false,
  prisma,
  config: {
    ...loadTestApiConfig(),
    databaseUrl: testFixtureDatabaseUrl(),
    storagePath: testStoragePath('category-name-identity'),
    authRateLimitMax: 1000,
    rateLimitMax: 1000,
  },
});
beforeAll(() => app.ready());
afterAll(() => app.close());

/** 请求仅发送给测试应用，入口守卫参数来自同一合成账本。 */
async function request(
  session: Session | null,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  payload: object,
  key?: string,
) {
  try {
    const headers: Record<string, string> = session ? { authorization: `Bearer ${session.access_token}` } : {};
    return await app.inject({
      method,
      url: await accountingRequestFixturePath(app, method, `/api/v1${path}`, headers),
      headers: { ...headers, ...(key ? { 'idempotency-key': key } : {}) },
      payload,
    });
  } catch (cause) {
    throw new Error(`分类语义测试请求失败：${method} ${path}`, { cause });
  }
}

/** 每项用例使用新的测试账号与账本，不读取或修改用户真实账号。 */
async function owner(): Promise<Owner> {
  try {
    const phone = `138${randomInt(100000000).toString().padStart(8, '0')}`;
    const password = 'category-name-identity-password';
    const registration = await request(null, 'POST', '/auth/register', {
      country_code: '+86',
      phone,
      password,
      device: { installation_id: randomUUID(), name: '分类身份测试设备', platform: 'test' },
    });
    expect(registration.statusCode, registration.body).toBe(201);
    const session = registration.json<Session>();
    const ledgerId = randomUUID();
    const ledger = await request(session, 'POST', '/ledgers', { id: ledgerId, name: '分类身份测试本' });
    expect(ledger.statusCode, ledger.body).toBe(201);
    return { session, phone, password, ledgerId };
  } catch (cause) {
    throw new Error('分类语义测试账号初始化失败', { cause });
  }
}

/** 提供完整分类语义，父节点不同的同名子分类保持不同身份。 */
function category(name: string, id = randomUUID(), parentId: string | null = null) {
  return {
    id,
    name,
    kind: 'expense',
    level: parentId ? 2 : 1,
    parent_id: parentId,
    icon: null as string | null,
    sort_order: 0,
  };
}

/** 同步包的实体和请求身份独立，重试不生成新的分类 UUID。 */
function mutation(data: ReturnType<typeof category>, updatedAt = new Date().toISOString()) {
  const { id, ...payload } = data;
  return {
    mutation_id: randomUUID(),
    entity_type: 'category',
    entity_id: id,
    ledger_id: null,
    action: 'upsert',
    updated_at: updatedAt,
    payload,
  };
}

/** 合成账号的两个设备使用独立同步幂等域。 */
async function secondDevice(user: Owner): Promise<Session> {
  try {
    const response = await request(null, 'POST', '/auth/login', {
      country_code: '+86',
      phone: user.phone,
      password: user.password,
      device: { installation_id: randomUUID(), name: '分类身份第二设备', platform: 'test' },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<Session>();
  } catch (cause) {
    throw new Error('分类语义第二设备登录失败', { cause });
  }
}

it('两个设备跨REST与同步并发创建同名不同UUID，保留两份独立分类', async () => {
  try {
    const user = await owner();
    const second = await secondDevice(user);
    const name = `并发同语义${randomUUID()}`;
    const restData = category(name);
    const syncData = category(name);
    const [rest, sync] = await Promise.all([
      request(user.session, 'POST', `/ledgers/${user.ledgerId}/categories`, restData),
      request(second, 'POST', '/sync/push', { device_id: second.device_id, changes: [mutation(syncData)] }),
    ]);
    expect(sync.statusCode, sync.body).toBe(200);
    const outcome = sync.json().outcomes[0];
    expect(rest.statusCode, rest.body).toBe(201);
    expect(outcome).toMatchObject({ status: 'accepted' });
    expect(await prisma.category.count({ where: { ownerId: user.session.user.user_id, name, deletedAt: null } })).toBe(
      2,
    );
  } catch (cause) {
    throw new Error('同名分类并发创建与身份独立验证失败', { cause });
  }
});

it('历史不同UUID同语义保留，编辑原分类图标不合并也不改挂旧交易', async () => {
  try {
    const user = await owner();
    const name = `历史同语义${randomUUID()}`;
    const identities = [randomUUID(), randomUUID()];
    for (const id of identities) {
      await prisma.category.create({
        data: {
          id,
          ownerId: user.session.user.user_id,
          name,
          kind: 'expense',
          level: 1,
          parentId: null,
          updatedAt: new Date(),
          updatedByDeviceId: user.session.device_id,
        },
      });
      const transaction = await request(user.session, 'POST', `/ledgers/${user.ledgerId}/transactions`, {
        id: randomUUID(),
        tx_type: 'expense',
        amount: '10',
        native_amount: '10',
        currency_code: 'CNY',
        happened_at: new Date().toISOString(),
        category_id: id,
      });
      expect(transaction.statusCode, transaction.body).toBe(201);
    }
    const select = {
      id: true,
      categoryId: true,
      amount: true,
      nativeAmount: true,
      happenedAt: true,
      revision: true,
      deletedAt: true,
    } as const;
    const before = await prisma.transaction.findMany({
      where: { ledgerId: user.ledgerId },
      orderBy: { id: 'asc' },
      select,
    });
    const updated = await request(user.session, 'PATCH', `/ledgers/${user.ledgerId}/categories/${identities[0]}`, {
      icon: 'coffee',
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(
      await prisma.category.findMany({ where: { ownerId: user.session.user.user_id, name, deletedAt: null } }),
    ).toHaveLength(2);
    expect(
      await prisma.transaction.findMany({ where: { ledgerId: user.ledgerId }, orderBy: { id: 'asc' }, select }),
    ).toEqual(before);
  } catch (cause) {
    throw new Error('历史分类身份与交易保留验证失败', { cause });
  }
});

it('自定义父分类有活子级时REST与同步都拒绝单独删除，先删子级后父级可确认', async () => {
  try {
    const user = await owner();
    const parent = category(`自定义父${randomUUID()}`);
    const child = category(`自定义子${randomUUID()}`, randomUUID(), parent.id);
    for (const data of [parent, child])
      expect((await request(user.session, 'POST', `/ledgers/${user.ledgerId}/categories`, data)).statusCode).toBe(201);
    const rest = await request(user.session, 'DELETE', `/ledgers/${user.ledgerId}/categories/${parent.id}`, {});
    expect(rest.statusCode, rest.body).toBe(409);
    expect(rest.json()).toMatchObject({ code: 'CATEGORY_HAS_CHILDREN' });
    const parentDelete = { ...mutation(parent, new Date(Date.now() + 1000).toISOString()), action: 'delete' };
    const rejected = await request(user.session, 'POST', '/sync/push', {
      device_id: user.session.device_id,
      changes: [parentDelete],
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json().outcomes[0]).toMatchObject({ status: 'invalid', code: 'CATEGORY_HAS_CHILDREN' });
    const childDelete = { ...mutation(child, new Date(Date.now() + 1000).toISOString()), action: 'delete' };
    const accepted = await request(user.session, 'POST', '/sync/push', {
      device_id: user.session.device_id,
      changes: [
        childDelete,
        { ...parentDelete, mutation_id: randomUUID(), updated_at: new Date(Date.now() + 2000).toISOString() },
      ],
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().outcomes.map((row: { status: string }) => row.status)).toEqual(['accepted', 'accepted']);
    expect(
      await prisma.category.count({
        where: { ownerId: user.session.user.user_id, id: { in: [parent.id, child.id] }, deletedAt: null },
      }),
    ).toBe(0);
  } catch (cause) {
    throw new Error('自定义父子分类删除关系验证失败', { cause });
  }
});
