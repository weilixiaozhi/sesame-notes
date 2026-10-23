import { accountingRequestFixturePath } from './accounting-request-fixture.js';
import { testStoragePath } from './test-storage-path.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomInt, randomUUID } from 'node:crypto';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';

const config: ApiConfig = {
  databaseUrl: testFixtureDatabaseUrl(),
  jwtSecret: 'archive-test-secret-that-is-at-least-32-bytes-long',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  storagePath: testStoragePath('ledger-archive'),
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
const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
const app = buildApp({ logger: false, config, prisma });
type Session = { access_token: string; device_id: string; user: { user_id: string } };

beforeAll(async () => app.ready());
afterAll(async () => app.close());

/** 使用真实接口验证身份、序列化和同步投递边界。 */
async function api(method: 'GET' | 'POST' | 'DELETE', path: string, session: Session, payload?: object) {
  try {
    return await app.inject({
      method,
      url: await accountingRequestFixturePath(app, method, `/api/v1${path}`, {
        authorization: `Bearer ${session.access_token}`,
      }),
      headers: { authorization: `Bearer ${session.access_token}` },
      payload,
    });
  } catch (error) {
    throw new Error(`归档测试请求失败：${method} ${path}`, { cause: error });
  }
}

/** 注册账号并登录第二台设备，覆盖同账号多端状态。 */
async function account() {
  try {
    const credentials = {
      country_code: '+86',
      phone: `139${randomInt(10000000, 100000000)}`,
      password: 'password-123456',
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { ...credentials, device: { installation_id: randomUUID(), name: 'archive-first', platform: 'e2e' } },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { ...credentials, device: { installation_id: randomUUID(), name: 'archive-second', platform: 'e2e' } },
    });
    expect(second.statusCode).toBe(200);
    return [first.json<Session>(), second.json<Session>()] as const;
  } catch (error) {
    throw new Error('归档测试账号创建失败', { cause: error });
  }
}

/** 建立 Owner 与普通成员共享的账本。 */
async function fixture() {
  try {
    const [owner] = await account();
    const [member, secondDevice] = await account();
    const created = await api('POST', '/ledgers', owner, { name: '个人归档账本' });
    expect(created.statusCode).toBe(201);
    const ledger = created.json<{ id: string; sync_id: string }>();
    const invited = await api('POST', `/ledgers/${ledger.id}/invites`, owner, { role: 'editor' });
    expect(invited.statusCode).toBe(201);
    const accepted = await api('POST', `/invites/${invited.json().code}/accept`, member, {});
    expect(accepted.statusCode).toBe(200);
    return { owner, member, secondDevice, ledger };
  } catch (error) {
    throw new Error('归档共享场景初始化失败', { cause: error });
  }
}

/** 模拟已有离线队列推送归档或取消归档。 */
async function archive(
  session: Session,
  ledger: { id: string; sync_id: string },
  archived: boolean,
  time: string,
  mutationId = randomUUID(),
) {
  try {
    return await api('POST', '/sync/push', session, {
      device_id: session.device_id,
      changes: [
        {
          mutation_id: mutationId,
          entity_type: 'ledger_archive',
          entity_id: ledger.id,
          ledger_id: ledger.id,
          sync_id: ledger.sync_id,
          action: 'upsert',
          updated_at: time,
          payload: { archived },
        },
      ],
    });
  } catch (error) {
    throw new Error('归档队列推送失败', { cause: error });
  }
}

describe('个人账本归档', () => {
  it('归档确认水位对应各自快照，旧版本与幂等重放返回当前归档事件水位', async () => {
    const { member, ledger } = await fixture();
    const firstId = randomUUID();
    const restoreId = randomUUID();
    const request = {
      device_id: member.device_id,
      changes: [
        {
          mutation_id: firstId,
          entity_type: 'ledger_archive',
          entity_id: ledger.id,
          ledger_id: ledger.id,
          sync_id: ledger.sync_id,
          action: 'upsert',
          updated_at: '2026-08-20T10:00:00.000Z',
          payload: { archived: true },
        },
        {
          mutation_id: restoreId,
          entity_type: 'ledger_archive',
          entity_id: ledger.id,
          ledger_id: ledger.id,
          sync_id: ledger.sync_id,
          action: 'upsert',
          updated_at: '2026-08-20T10:01:00.000Z',
          payload: { archived: false },
        },
      ],
    };
    const response = await api('POST', '/sync/push', member, request);
    expect(response.statusCode).toBe(200);
    const [first, restored] = response.json().outcomes;
    expect(first.status).toBe('accepted');
    expect(restored.status).toBe('accepted');
    expect(first.current_entity.server_cursor).toBe(first.change_id);
    expect(restored.current_entity.server_cursor).toBe(restored.change_id);
    expect(BigInt(first.current_entity.server_cursor)).toBeLessThan(BigInt(restored.current_entity.server_cursor));
    const outdated = await archive(member, ledger, true, '2026-08-20T10:00:00.000Z');
    expect(outdated.json().outcomes[0]).toMatchObject({
      status: 'ignored',
      current_entity: { archived_at: null, server_cursor: restored.change_id },
    });
    const replayed = await archive(member, ledger, true, '2026-08-20T10:00:00.000Z', firstId);
    expect(replayed.json().outcomes[0]).toMatchObject({
      status: 'ignored',
      change_id: first.change_id,
      current_entity: { archived_at: null, server_cursor: restored.change_id },
    });
  });

  it('不同设备同一时间的归档选择仍按设备版本决胜', async () => {
    const { member, secondDevice, ledger } = await fixture();
    const [low, high] = member.device_id < secondDevice.device_id ? [member, secondDevice] : [secondDevice, member];
    const time = '2026-08-20T10:00:00.000Z';
    expect((await archive(high, ledger, true, time)).json().outcomes[0].status).toBe('accepted');
    expect((await archive(low, ledger, false, time)).json().outcomes[0]).toMatchObject({
      status: 'ignored',
      current_entity: { ledger_id: ledger.id, archived_at: time, updated_at: time, device_id: high.device_id },
    });
  });

  it('同设备同秒归档后恢复按队列顺序生效，重放最初归档不会反向覆盖恢复', async () => {
    const { member, secondDevice, ledger } = await fixture();
    const time = '2026-08-20T10:00:00.000Z';
    const firstMutationId = randomUUID();
    expect((await archive(member, ledger, true, time, firstMutationId)).json().outcomes[0].status).toBe('accepted');
    const restored = await archive(member, ledger, false, time);
    expect(restored.statusCode).toBe(200);
    expect(restored.json().outcomes[0]).toMatchObject({
      status: 'accepted',
      current_entity: { ledger_id: ledger.id, archived_at: null, updated_at: time, device_id: member.device_id },
    });
    const replayed = await archive(member, ledger, true, time, firstMutationId);
    expect(replayed.json().outcomes[0]).toMatchObject({
      status: 'ignored',
      current_entity: { ledger_id: ledger.id, archived_at: null, updated_at: time, device_id: member.device_id },
    });
    expect((await api('GET', `/sync/full?ledger_id=${ledger.id}`, secondDevice)).json().ledger).toMatchObject({
      archived_at: null,
      archive_updated_at: time,
      archive_device_id: member.device_id,
    });
    const changes = (await api('GET', '/sync/pull', secondDevice))
      .json()
      .changes.filter((change: { entity_type: string }) => change.entity_type === 'ledger_archive');
    expect(changes.map((change: { payload: { archived_at: string | null } }) => change.payload.archived_at)).toEqual([
      time,
      null,
    ]);
  });

  it('未来设备时间被裁剪后，accepted 响应返回与 full 一致的权威归档版本', async () => {
    const { owner, ledger } = await fixture();
    const before = Date.now();
    const response = await archive(owner, ledger, true, '2099-01-01T00:00:00.000Z');
    expect(response.statusCode).toBe(200);
    const outcome = response.json().outcomes[0];
    expect(outcome.status).toBe('accepted');
    expect(outcome.current_entity).toEqual({
      ledger_id: ledger.id,
      archived_at: expect.any(String),
      updated_at: expect.any(String),
      device_id: owner.device_id,
      server_cursor: outcome.change_id,
    });
    const canonical = outcome.current_entity;
    expect(canonical.archived_at).toBe(canonical.updated_at);
    expect(Date.parse(canonical.updated_at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(canonical.updated_at)).toBeLessThanOrEqual(Date.now() + 5000);
    expect((await api('GET', `/sync/full?ledger_id=${ledger.id}`, owner)).json().ledger).toMatchObject({
      archived_at: canonical.archived_at,
      archive_updated_at: canonical.updated_at,
      archive_device_id: canonical.device_id,
    });
  });

  it('普通成员可归档，仅本人另一设备通过 pull、列表和 full 取得状态，其他成员继续访问', async () => {
    const { owner, member, secondDevice, ledger } = await fixture();
    const sharedMember = await prisma.ledgerMember.findUniqueOrThrow({
      where: {
        ledgerId_linkedAccountId: { ledgerId: ledger.id, linkedAccountId: member.user.user_id },
      },
    });
    const time = '2026-08-20T10:00:00.000Z';
    const result = await archive(member, ledger, true, time);
    expect(result.statusCode).toBe(200);
    expect(result.json().outcomes[0].status).toBe('accepted');
    expect((await prisma.ledgerMember.findUniqueOrThrow({ where: { id: sharedMember.id } })).updatedAt).toEqual(
      sharedMember.updatedAt,
    );
    const ownPull = (await api('GET', '/sync/pull', secondDevice)).json().changes;
    expect(ownPull.filter((change: { entity_type: string }) => change.entity_type === 'ledger_archive')).toEqual([
      expect.objectContaining({
        ledger_id: null,
        entity_id: ledger.id,
        updated_at: time,
        device_id: member.device_id,
        payload: { ledger_id: ledger.id, archived_at: time },
      }),
    ]);
    const ownFields = { archived_at: time, archive_updated_at: time, archive_device_id: member.device_id };
    expect((await api('GET', '/ledgers', secondDevice)).json()).toEqual([expect.objectContaining(ownFields)]);
    expect((await api('GET', `/ledgers/${ledger.id}`, secondDevice)).json()).toMatchObject(ownFields);
    const full = await api('GET', `/sync/full?ledger_id=${ledger.id}`, secondDevice);
    expect(full.statusCode).toBe(200);
    expect(full.json().ledger).toMatchObject(ownFields);
    expect(full.json().members.every((row: object) => !('archived_at' in row))).toBe(true);
    const ownerPull = (await api('GET', '/sync/pull', owner)).json().changes;
    expect(ownerPull.some((change: { entity_type: string }) => change.entity_type === 'ledger_archive')).toBe(false);
    expect((await api('GET', `/sync/full?ledger_id=${ledger.id}`, owner)).json().ledger).toMatchObject({
      archived_at: null,
      archive_updated_at: null,
      archive_device_id: null,
    });
    expect((await api('GET', `/ledgers/${ledger.id}/transactions`, owner)).statusCode).toBe(200);
    const transaction = await api('POST', `/ledgers/${ledger.id}/transactions`, owner, {
      tx_type: 'expense',
      amount: '12',
      currency_code: 'CNY',
      native_amount: '12',
      happened_at: time,
    });
    expect(transaction.statusCode).toBe(201);
    const latest = (await api('GET', `/sync/full?ledger_id=${ledger.id}`, secondDevice)).json();
    expect(latest.transactions).toEqual([expect.objectContaining({ id: transaction.json().id })]);
    expect(latest.ledger).toMatchObject(ownFields);
  });

  it('Owner 可个人归档，取消归档按独立时间版本恢复，不被较旧离线归档覆盖', async () => {
    const { owner, member, ledger } = await fixture();
    const firstMutationId = randomUUID();
    expect(
      (await archive(owner, ledger, true, '2026-08-20T10:00:00.000Z', firstMutationId)).json().outcomes[0].status,
    ).toBe('accepted');
    expect((await archive(owner, ledger, false, '2026-08-20T10:02:00.000Z')).json().outcomes[0].status).toBe(
      'accepted',
    );
    expect((await archive(owner, ledger, true, '2026-08-20T10:01:00.000Z')).json().outcomes[0].status).toBe('ignored');
    const outdated = await archive(owner, ledger, true, '2026-08-20T10:01:00.000Z');
    expect(outdated.json().outcomes[0].current_entity).toEqual({
      ledger_id: ledger.id,
      archived_at: null,
      updated_at: '2026-08-20T10:02:00.000Z',
      device_id: owner.device_id,
      server_cursor: expect.any(String),
    });
    const replayed = await archive(owner, ledger, true, '2026-08-20T10:00:00.000Z', firstMutationId);
    expect(replayed.json().outcomes[0]).toMatchObject({
      status: 'ignored',
      current_entity: {
        ledger_id: ledger.id,
        archived_at: null,
        updated_at: '2026-08-20T10:02:00.000Z',
        device_id: owner.device_id,
      },
    });
    expect((await api('GET', `/ledgers/${ledger.id}`, owner)).json()).toMatchObject({
      archived_at: null,
      archive_updated_at: '2026-08-20T10:02:00.000Z',
      archive_device_id: owner.device_id,
    });
    expect((await api('GET', `/ledgers/${ledger.id}`, member)).json()).toMatchObject({ archive_updated_at: null });
  });

  it('无关账号及退出成员不能归档，已删除账本不能通过归档恢复', async () => {
    const { owner, member, ledger } = await fixture();
    const [outsider] = await account();
    const unauthorized = await archive(outsider, ledger, true, '2026-08-20T10:00:00.000Z');
    expect(unauthorized.statusCode).toBe(200);
    expect(unauthorized.json().outcomes[0].status).toBe('invalid');
    expect((await api('POST', `/ledgers/${ledger.id}/leave`, member, {})).statusCode).toBe(204);
    expect((await archive(member, ledger, true, '2026-08-20T10:00:00.000Z')).json().outcomes[0].status).toBe('invalid');
    expect((await api('DELETE', `/ledgers/${ledger.id}`, owner)).statusCode).toBe(204);
    expect((await archive(owner, ledger, false, '2026-08-20T10:00:00.000Z')).json().outcomes[0].status).toBe('invalid');
    expect((await api('GET', '/ledgers', owner)).json()).toEqual([]);
  });
});
