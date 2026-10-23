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

it('两个设备跨REST与同步并发创建同语义不同UUID，只提交一个分类', async () => {
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
    expect([rest.statusCode === 201, outcome.status === 'accepted'].filter(Boolean)).toHaveLength(1);
    if (rest.statusCode !== 201) expect(rest.json()).toMatchObject({ code: 'CATEGORY_NAME_CONFLICT' });
    if (outcome.status !== 'accepted')
      expect(outcome).toMatchObject({ status: 'invalid', code: 'CATEGORY_NAME_CONFLICT' });
    expect(await prisma.category.count({ where: { ownerId: user.session.user.user_id, name, deletedAt: null } })).toBe(
      1,
    );
  } catch (cause) {
    throw new Error('分类语义并发唯一性验证失败', { cause });
  }
});

it('同实体两设备编辑与冻结请求重放不会因自己同名而被拒绝', async () => {
  try {
    const user = await owner();
    const second = await secondDevice(user);
    const data = category(`同实体${randomUUID()}`);
    const first = mutation(data);
    const body = { device_id: user.session.device_id, changes: [first] };
    const accepted = await request(user.session, 'POST', '/sync/push', body);
    expect(accepted.json().outcomes[0]).toMatchObject({ status: 'accepted' });
    const replay = await request(user.session, 'POST', '/sync/push', body);
    expect(replay.json().outcomes[0]).toMatchObject({ status: 'ignored' });
    const next = mutation({ ...data, icon: 'coffee' }, new Date(Date.now() + 1000).toISOString());
    const edited = await request(second, 'POST', '/sync/push', { device_id: second.device_id, changes: [next] });
    expect(edited.json().outcomes[0].status).toBe('accepted');
    expect(
      await prisma.category.count({ where: { ownerId: user.session.user.user_id, name: data.name, deletedAt: null } }),
    ).toBe(1);
  } catch (cause) {
    throw new Error('分类同实体幂等与双设备编辑验证失败', { cause });
  }
});

it('较旧分类修改的ignored回执返回当前Owner快照，存活和删除状态均不被旧内容覆盖', async () => {
  try {
    const user = await owner();
    const data = category(`较旧回执${randomUUID()}`);
    const newestTime = new Date(Date.now() + 1000).toISOString();
    const oldTime = new Date(Date.now() - 1000).toISOString();
    const created = await request(user.session, 'POST', '/sync/push', {
      device_id: user.session.device_id,
      changes: [mutation(data, newestTime)],
    });
    expect(created.statusCode, created.body).toBe(200);
    const live = created.json().outcomes[0].category_state;
    expect(live).toMatchObject({ id: data.id, owner_id: user.session.user.user_id, deleted_at: null });
    for (const deleted of [false, true]) {
      if (deleted) {
        const deletion = await request(user.session, 'POST', '/sync/push', {
          device_id: user.session.device_id,
          changes: [{ ...mutation(data, new Date(Date.now() + 2000).toISOString()), action: 'delete' }],
        });
        expect(deletion.statusCode, deletion.body).toBe(200);
        expect(deletion.json().outcomes[0].status).toBe('accepted');
      }
      const before = await prisma.category.findUniqueOrThrow({
        where: { id_ownerId: { id: data.id, ownerId: user.session.user.user_id } },
      });
      const events = await prisma.syncChange.count({ where: { entityId: data.id, entityType: 'category' } });
      const stale = await request(user.session, 'POST', '/sync/push', {
        device_id: user.session.device_id,
        changes: [mutation({ ...data, name: '旧设备正文' }, oldTime)],
      });
      expect(stale.statusCode, stale.body).toBe(200);
      const outcome = stale.json().outcomes[0];
      expect(outcome).toMatchObject({
        status: 'ignored',
        change_id: null,
        current_deleted: deleted,
        category_state: {
          id: data.id,
          owner_id: user.session.user.user_id,
          name: before.name,
          updated_at: before.updatedAt.toISOString(),
          deleted_at: before.deletedAt?.toISOString() ?? null,
        },
      });
      expect(outcome.category_state.version_token).toMatch(/^[a-f0-9]{64}$/);
      expect(
        await prisma.category.findUniqueOrThrow({
          where: { id_ownerId: { id: data.id, ownerId: user.session.user.user_id } },
        }),
      ).toEqual(before);
      expect(await prisma.syncChange.count({ where: { entityId: data.id, entityType: 'category' } })).toBe(events);
    }
  } catch (cause) {
    throw new Error('分类较旧回执权威状态验证失败', { cause });
  }
});

it('不同父分类和不同Owner的同名内容不被误合并', async () => {
  try {
    const user = await owner();
    const other = await owner();
    const name = `同名子分类${randomUUID()}`;
    const parents = [category(`父甲${randomUUID()}`), category(`父乙${randomUUID()}`)];
    for (const parent of parents) {
      expect((await request(user.session, 'POST', `/ledgers/${user.ledgerId}/categories`, parent)).statusCode).toBe(
        201,
      );
      expect(
        (
          await request(
            user.session,
            'POST',
            `/ledgers/${user.ledgerId}/categories`,
            category(name, randomUUID(), parent.id),
          )
        ).statusCode,
      ).toBe(201);
    }
    expect(
      (await request(other.session, 'POST', `/ledgers/${other.ledgerId}/categories`, category(name))).statusCode,
    ).toBe(201);
    expect(await prisma.category.count({ where: { ownerId: user.session.user.user_id, name, deletedAt: null } })).toBe(
      2,
    );
    expect(await prisma.category.count({ where: { ownerId: other.session.user.user_id, name, deletedAt: null } })).toBe(
      1,
    );
  } catch (cause) {
    throw new Error('分类父关系与账号语义隔离验证失败', { cause });
  }
});

it.each(['REST', 'import', 'batch'] as const)('%s 使用相同规范名称拒绝不同UUID，保留既有分类', async (transport) => {
  try {
    const user = await owner();
    const original = category(`规范名称${randomUUID()}`);
    expect((await request(user.session, 'POST', `/ledgers/${user.ledgerId}/categories`, original)).statusCode).toBe(
      201,
    );
    const duplicate = category(`\u0085${original.name}\u0085`);
    const path = `/ledgers/${user.ledgerId}/${transport === 'import' ? 'imports' : transport === 'batch' ? 'categories/add-batch' : 'categories'}`;
    const response = await request(
      user.session,
      'POST',
      path,
      transport === 'import' ? { categories: [duplicate] } : transport === 'batch' ? { items: [duplicate] } : duplicate,
      transport === 'batch' ? randomUUID() : undefined,
    );
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ code: 'CATEGORY_NAME_CONFLICT' });
    expect(
      await prisma.category.count({
        where: { ownerId: user.session.user.user_id, name: original.name, deletedAt: null },
      }),
    ).toBe(1);
    expect(await prisma.category.count({ where: { ownerId: user.session.user.user_id, id: duplicate.id } })).toBe(0);
  } catch (cause) {
    throw new Error(`${transport} 分类同语义入口验证失败`, { cause });
  }
});

it('改名冲突拒绝而唯一新名允许，原实体身份保持不变', async () => {
  try {
    const user = await owner();
    const first = category(`原名称${randomUUID()}`);
    const other = category(`目标名称${randomUUID()}`);
    for (const data of [first, other])
      expect((await request(user.session, 'POST', `/ledgers/${user.ledgerId}/categories`, data)).statusCode).toBe(201);
    const conflict = await request(user.session, 'PATCH', `/ledgers/${user.ledgerId}/categories/${first.id}`, {
      name: other.name,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'CATEGORY_NAME_CONFLICT' });
    const name = `唯一新名称${randomUUID()}`;
    const updated = await request(user.session, 'PATCH', `/ledgers/${user.ledgerId}/categories/${first.id}`, { name });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(
      await prisma.category.findUniqueOrThrow({
        where: { id_ownerId: { id: first.id, ownerId: user.session.user.user_id } },
      }),
    ).toMatchObject({ name, deletedAt: null });
  } catch (cause) {
    throw new Error('分类改名唯一性验证失败', { cause });
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

it('恢复旧UUID不能与现存同语义新UUID并存，保留双方既有状态', async () => {
  try {
    const user = await owner();
    const old = category(`恢复语义${randomUUID()}`);
    expect((await request(user.session, 'POST', `/ledgers/${user.ledgerId}/categories`, old)).statusCode).toBe(201);
    const deletedAt = new Date();
    await prisma.category.update({
      where: { id_ownerId: { id: old.id, ownerId: user.session.user.user_id } },
      data: { deletedAt },
    });
    const active = category(old.name);
    expect((await request(user.session, 'POST', `/ledgers/${user.ledgerId}/categories`, active)).statusCode).toBe(201);
    const response = await request(user.session, 'POST', '/sync/push', {
      device_id: user.session.device_id,
      changes: [mutation(old, new Date(Date.now() + 1000).toISOString())],
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().outcomes[0]).toMatchObject({ status: 'invalid', code: 'CATEGORY_NAME_CONFLICT' });
    expect(
      await prisma.category.findUniqueOrThrow({
        where: { id_ownerId: { id: old.id, ownerId: user.session.user.user_id } },
      }),
    ).toMatchObject({ deletedAt });
    expect(
      await prisma.category.findUniqueOrThrow({
        where: { id_ownerId: { id: active.id, ownerId: user.session.user.user_id } },
      }),
    ).toMatchObject({ deletedAt: null });
    expect(
      await prisma.category.count({ where: { ownerId: user.session.user.user_id, name: old.name, deletedAt: null } }),
    ).toBe(1);
  } catch (cause) {
    throw new Error('分类恢复语义唯一性验证失败', { cause });
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

it('其他Owner相同UUID父级的活子级不会阻止当前Owner删除自己的叶子', async () => {
  try {
    const user = await owner();
    const other = await owner();
    const parentId = randomUUID();
    const parent = category(`所有者隔离父${randomUUID()}`, parentId);
    for (const account of [user, other])
      expect(
        (await request(account.session, 'POST', `/ledgers/${account.ledgerId}/categories`, parent)).statusCode,
      ).toBe(201);
    const foreignChild = category(`其他Owner子${randomUUID()}`, randomUUID(), parentId);
    expect(
      (await request(other.session, 'POST', `/ledgers/${other.ledgerId}/categories`, foreignChild)).statusCode,
    ).toBe(201);
    const response = await request(user.session, 'POST', '/sync/push', {
      device_id: user.session.device_id,
      changes: [{ ...mutation(parent, new Date(Date.now() + 1000).toISOString()), action: 'delete' }],
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().outcomes[0]).toMatchObject({ status: 'accepted' });
    expect(
      await prisma.category.count({
        where: { ownerId: other.session.user.user_id, id: { in: [parentId, foreignChild.id] }, deletedAt: null },
      }),
    ).toBe(2);
  } catch (cause) {
    throw new Error('跨所有者分类删除关系隔离验证失败', { cause });
  }
});
