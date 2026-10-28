import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadTestApiConfig } from './test-api-config.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { fitnessTemplate } from './fitness-fixtures.js';

const prisma = new PrismaClient({ datasourceUrl: testFixtureDatabaseUrl() });
const app = buildApp({ logger: false, prisma, config: { ...loadTestApiConfig(), authRateLimitMax: 10000 } });
const time = '2026-10-28T00:00:00.000Z';
type Actor = { token: string; deviceId: string; userId: string };

beforeAll(() => app.ready());
afterAll(() => app.close());

/** 每项用例创建独立账号，所有请求都通过真实鉴权与数据库事务。 */
async function account(): Promise<Actor> {
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        country_code: '+86',
        phone: `138${randomInt(100_000_000).toString().padStart(8, '0')}`,
        password: 'original-values-test-password',
        device: { installation_id: randomUUID(), name: '原值验收', platform: 'test' },
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json();
    return { token: body.access_token, deviceId: body.device_id, userId: body.user.user_id };
  } catch (cause) {
    throw new Error('同步原值验收账号准备失败', { cause });
  }
}

/** 只构造公共变更外壳，实体归属字段由用例按真实协议填写。 */
function change(type: string, id: string, payload: Record<string, unknown>, scope: Record<string, unknown>) {
  return {
    mutation_id: randomUUID(),
    entity_type: type,
    entity_id: id,
    action: 'upsert',
    updated_at: time,
    payload,
    ...scope,
  };
}

/** 使用真实HTTP序列化保留错误类型，禁止测试替身预先把字符串或数字规范成合法值。 */
async function push(actor: Actor, changes: Record<string, unknown>[]) {
  try {
    return await app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${actor.token}` },
      payload: { device_id: actor.deviceId, changes },
    });
  } catch (cause) {
    throw new Error('同步原值HTTP请求失败', { cause });
  }
}

describe('所有同步实体共用原始输入边界', () => {
  it.each(['device_id', 'mutation_id', 'entity_id', 'ledger_id', 'entity_type', 'action', 'base_revision'])(
    '非法原始外壳 %s 必须整批拒绝，前面的合法变更也不能写入',
    async (field) => {
      try {
        const actor = await account();
        const ids = [randomUUID(), randomUUID()];
        const payload = { name: '外壳验收', currency: 'CNY', month_start_day: 1, aa_enabled: false };
        const first = change('ledger', ids[0]!, payload, { ledger_id: ids[0] });
        const second: Record<string, unknown> = change('ledger', ids[1]!, payload, { ledger_id: ids[1] });
        if (field !== 'device_id') second[field] = field === 'base_revision' ? '0' : [second[field]];
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/sync/push',
          headers: { authorization: `Bearer ${actor.token}` },
          payload: { device_id: field === 'device_id' ? [actor.deviceId] : actor.deviceId, changes: [first, second] },
        });
        expect({
          status: response.statusCode,
          ledgers: await prisma.ledger.count({ where: { id: { in: ids } } }),
          members: await prisma.ledgerMember.count({ where: { ledgerId: { in: ids } } }),
          events: await prisma.syncChange.count({ where: { entityId: { in: ids } } }),
        }).toEqual({ status: 400, ledgers: 0, members: 0, events: 0 });
        expect(response.json().code).toBe('VALIDATION_ERROR');
      } catch (cause) {
        throw new Error(`原始外壳整批拒绝验收失败：${field}`, { cause });
      }
    },
  );

  it.each([{ name: 123 }, { month_start_day: '1' }, { aa_enabled: 'false' }])(
    '非法账本字段 %j 不被框架转换为成功，后续合法变更仍提交',
    async (invalid) => {
      try {
        const actor = await account();
        const invalidId = randomUUID();
        const validId = randomUUID();
        const payload = { name: '原值账本', currency: 'CNY', month_start_day: 1, aa_enabled: false };
        const changes = [
          change('ledger', invalidId, { ...payload, ...invalid }, { ledger_id: invalidId }),
          change('ledger', validId, payload, { ledger_id: validId }),
        ];
        const response = await push(actor, changes);
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().outcomes).toMatchObject([{ status: 'invalid' }, { status: 'accepted' }]);
        expect(await prisma.ledger.findUnique({ where: { id: invalidId } })).toBeNull();
        expect(await prisma.ledgerMember.count({ where: { ledgerId: invalidId } })).toBe(0);
        expect(await prisma.syncChange.count({ where: { entityId: invalidId } })).toBe(0);
        expect(await prisma.ledger.findUniqueOrThrow({ where: { id: validId } })).toMatchObject({
          name: payload.name,
          monthStartDay: 1,
          aaEnabled: false,
        });
        const repeated = await push(actor, changes);
        expect(repeated.statusCode, repeated.body).toBe(200);
        expect(repeated.json().outcomes).toMatchObject([{ status: 'invalid' }, { status: 'ignored' }]);
        expect(await prisma.syncChange.count({ where: { entityId: validId } })).toBe(1);
      } catch (cause) {
        throw new Error('账本原始输入与混批状态验收失败', { cause });
      }
    },
  );

  it('个人归档拒绝字符串布尔，保持原状态且不写事件', async () => {
    try {
      const actor = await account();
      const id = randomUUID();
      const created = await push(actor, [
        change(
          'ledger',
          id,
          { name: '归档验收', currency: 'CNY', month_start_day: 1, aa_enabled: false },
          { ledger_id: id },
        ),
      ]);
      expect(created.statusCode, created.body).toBe(200);
      const ledger = await prisma.ledger.findUniqueOrThrow({ where: { id } });
      const where = { ledgerId_linkedAccountId: { ledgerId: id, linkedAccountId: actor.userId } };
      const before = await prisma.ledgerMember.findUniqueOrThrow({ where });
      const draft = change('ledger_archive', id, { archived: 'true' }, { ledger_id: id, sync_id: ledger.syncId });
      const response = await push(actor, [draft]);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().outcomes[0]).toMatchObject({ status: 'invalid', code: 'INVALID_SYNC_PAYLOAD' });
      expect(await prisma.ledgerMember.findUniqueOrThrow({ where })).toEqual(before);
      expect(await prisma.syncChange.count({ where: { mutationId: draft.mutation_id } })).toBe(0);
      const valid = await push(actor, [{ ...draft, mutation_id: randomUUID(), payload: { archived: true } }]);
      expect(valid.json().outcomes[0].status).toBe('accepted');
      expect((await prisma.ledgerMember.findUniqueOrThrow({ where })).archivedAt).not.toBeNull();
    } catch (cause) {
      throw new Error('归档标记原值验收失败', { cause });
    }
  });

  it('健身空间拒绝数字名称，合法字符串名称按原值创建', async () => {
    try {
      const actor = await account();
      const id = randomUUID();
      const scope = { ledger_id: null, day_book_id: null, memo_book_id: null, fitness_space_id: id };
      const draft = change('fitness_space', id, { name: 123, created_at: time, updated_at: time }, scope);
      const response = await push(actor, [draft]);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().outcomes[0]).toMatchObject({ status: 'invalid', code: 'INVALID_BOOK' });
      expect(await prisma.fitnessSpace.findUnique({ where: { id } })).toBeNull();
      expect(await prisma.syncChange.count({ where: { entityId: id } })).toBe(0);
      const valid = await push(actor, [
        { ...draft, mutation_id: randomUUID(), payload: { ...draft.payload, name: '123' } },
      ]);
      expect(valid.json().outcomes[0].status).toBe('accepted');
      expect((await prisma.fitnessSpace.findUniqueOrThrow({ where: { id } })).name).toBe('123');
    } catch (cause) {
      throw new Error('健身空间名称原值验收失败', { cause });
    }
  });

  it('字符串恢复标记不能清空空间或轮换同步身份，合法布尔恢复仍可执行', async () => {
    try {
      const actor = await account();
      const id = randomUUID();
      const scope = { ledger_id: null, day_book_id: null, memo_book_id: null, fitness_space_id: id };
      const payload = { name: '恢复验收', created_at: time, updated_at: time };
      const created = await push(actor, [change('fitness_space', id, payload, scope)]);
      expect(created.json().outcomes[0].status).toBe('accepted');
      const syncId = created.json().outcomes[0].sync_id;
      const templateId = randomUUID();
      const child = await push(actor, [
        change('fitness_template', templateId, fitnessTemplate(), { ...scope, sync_id: syncId }),
      ]);
      expect(child.json().outcomes[0].status).toBe('accepted');
      const full = await app.inject({
        method: 'GET',
        url: `/api/v1/sync/fitness-spaces/full?fitness_space_id=${id}`,
        headers: { authorization: `Bearer ${actor.token}` },
      });
      expect(full.statusCode, full.body).toBe(200);
      const before = await prisma.fitnessSpace.findUniqueOrThrow({ where: { id } });
      const children = await prisma.fitnessEntity.findMany({ where: { fitnessSpaceId: id } });
      const events = await prisma.syncChange.count({ where: { fitnessSpaceId: id } });
      const draft = change(
        'fitness_space',
        id,
        { ...payload, restore: 'true', expected_full_cursor: full.json().server_cursor },
        {
          ...scope,
          sync_id: syncId,
          base_revision: before.revision,
        },
      );
      const response = await push(actor, [draft]);
      expect(response.statusCode, response.body).toBe(200);
      expect({
        outcome: response.json().outcomes[0],
        space: await prisma.fitnessSpace.findUniqueOrThrow({ where: { id } }),
        children: await prisma.fitnessEntity.findMany({ where: { fitnessSpaceId: id } }),
        events: await prisma.syncChange.count({ where: { fitnessSpaceId: id } }),
      }).toMatchObject({ outcome: { status: 'invalid', code: 'INVALID_BOOK' }, space: before, children, events });
      const valid = await push(actor, [
        { ...draft, mutation_id: randomUUID(), payload: { ...draft.payload, restore: true } },
      ]);
      expect(valid.json().outcomes[0].status).toBe('accepted');
      expect(valid.json().outcomes[0].sync_id).not.toBe(syncId);
      expect(await prisma.fitnessEntity.count({ where: { fitnessSpaceId: id } })).toBe(0);
    } catch (cause) {
      throw new Error('恢复标记原值与持久化副作用验收失败', { cause });
    }
  });
});
