import { testStoragePath } from './test-storage-path.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { exchangeRateOverrideId } from '../src/modules/accounting/index.js';
import type { SyncMutationEnvelope } from '../src/shared/sync-mutation.js';

type Session = { access_token: string; device_id: string; user: { user_id: string } };
type Event = {
  change_id: string;
  entity_type: string;
  entity_id: string;
  mutation_id: string;
  action: string;
  updated_at: string;
  payload: Record<string, unknown>;
};
type FullSnapshot = {
  ledger: Record<string, unknown>;
  members: Array<Record<string, unknown>>;
  categories: Array<Record<string, unknown>>;
  recurring_transactions: Array<Record<string, unknown>>;
  exchange_rate_overrides: Array<Record<string, unknown>>;
};

const databaseUrl = testFixtureDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = buildApp({
  prisma,
  logger: false,
  config: loadConfig({
    DATABASE_URL: databaseUrl,
    JWT_SECRET: 'sync-payload-test-secret-at-least-32-bytes',
    STORAGE_PATH: process.env.STORAGE_PATH ?? testStoragePath('sync-payload'),
    RATE_LIMIT_MAX: '10000',
    AUTH_RATE_LIMIT_MAX: '10000',
  }),
});

beforeAll(async () => {
  try {
    await app.ready();
  } catch (cause) {
    await app.close();
    throw new Error('同步载荷测试服务初始化失败', { cause });
  }
});

afterAll(async () => {
  try {
    await app.close();
  } catch (cause) {
    throw new Error('同步载荷测试服务关闭失败', { cause });
  }
});

/** 通过真实 HTTP 入口读写同步数据，失败时保留请求路径上下文。 */
async function api(method: 'GET' | 'POST', path: string, session?: Session, payload?: Record<string, unknown>) {
  try {
    return await app.inject({
      method,
      url: `/api/v1${path}`,
      headers: session ? { authorization: `Bearer ${session.access_token}` } : {},
      payload,
    });
  } catch (cause) {
    throw new Error(`同步载荷测试请求失败：${method} ${path}`, { cause });
  }
}

/** 为场景注册独立账号，所有实体都使用真实登录权限写入。 */
async function register(): Promise<Session> {
  try {
    const response = await api('POST', '/auth/register', undefined, {
      country_code: '+86',
      phone: `137${randomInt(100_000_000).toString().padStart(8, '0')}`,
      password: 'sync-payload-password',
      device: { installation_id: randomUUID(), name: '同步载荷测试', platform: 'test' },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<Session>();
  } catch (cause) {
    throw new Error('同步载荷测试注册失败', { cause });
  }
}

/** 创建同步外壳，payload 仅使用生成 SDK 的请求字段，身份与版本时间放在外层。 */
function mutation(
  entityType: string,
  entityId: string,
  updatedAt: string,
  payload: Record<string, unknown>,
  scope: { ledger_id?: string; sync_id?: string } = {},
): SyncMutationEnvelope {
  return {
    mutation_id: randomUUID(),
    entity_type: entityType,
    entity_id: entityId,
    ledger_id: scope.ledger_id ?? null,
    ...(scope.sync_id === undefined ? {} : { sync_id: scope.sync_id }),
    action: 'upsert',
    updated_at: updatedAt,
    payload,
  };
}

/** 推送完整冻结请求，并区分首次接受与幂等重放。 */
async function push(session: Session, changes: SyncMutationEnvelope[], status: 'accepted' | 'ignored' = 'accepted') {
  try {
    const response = await api('POST', '/sync/push', session, { device_id: session.device_id, changes });
    expect(response.statusCode, response.body).toBe(200);
    const outcomes = response.json<{ outcomes: Array<{ status: string; change_id: string }> }>().outcomes;
    expect(
      outcomes.map((outcome) => outcome.status),
      response.body,
    ).toEqual(changes.map(() => status));
    return outcomes;
  } catch (cause) {
    throw new Error('同步载荷测试推送失败', { cause });
  }
}

/** 经权限过滤读取客户端实际获得的事件，而不是仅检查数据库事件行。 */
async function pull(session: Session): Promise<Event[]> {
  try {
    const response = await api('GET', '/sync/pull?since=0&limit=1000', session);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ changes: Event[] }>().changes;
  } catch (cause) {
    throw new Error('同步载荷测试拉取失败', { cause });
  }
}

/** 读取当前账本完整快照，直接比较两个读取协议对同一实体的表达。 */
async function full(session: Session, ledgerId: string): Promise<FullSnapshot> {
  try {
    const response = await api('GET', `/sync/full?ledger_id=${ledgerId}`, session);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<FullSnapshot>();
  } catch (cause) {
    throw new Error('同步载荷测试完整快照读取失败', { cause });
  }
}

it('SDK 最小载荷生成完整权威事件，连续版本、幂等重放及删除与完整快照一致', async () => {
  try {
    const session = await register();
    const ledgerId = randomUUID();
    const created = await api('POST', '/ledgers', session, { id: ledgerId, name: '同步载荷账本' });
    expect(created.statusCode, created.body).toBe(201);
    const scope = { ledger_id: ledgerId, sync_id: created.json<{ sync_id: string }>().sync_id };
    const defaultCategories = (await full(session, ledgerId)).categories;
    expect(defaultCategories).toHaveLength(61);
    const categoryId = randomUUID();
    const recurringId = randomUUID();
    const rateId = exchangeRateOverrideId(session.user.user_id, 'USD', 'CNY');
    const ids = [categoryId, recurringId, rateId];
    const versions = ['2026-09-01T00:00:00.000Z', '2026-09-01T01:00:00.000Z'];
    const batches: SyncMutationEnvelope[][] = [];
    const acceptedIds: string[][] = [];

    for (const [index, timestamp] of versions.entries()) {
      const changes = [
        mutation('category', categoryId, timestamp, {
          name: `\u0085 分类${index} \u3000`,
          kind: 'expense',
          level: 1,
          sort_order: index,
          icon: null,
          parent_id: null,
        }),
        mutation(
          'recurring_transaction',
          recurringId,
          timestamp,
          {
            tx_type: 'expense',
            amount: index === 0 ? '1.5' : '2.5',
            currency_code: 'CNY',
            category_id: categoryId,
            note: `周期版本${index}`,
            frequency: 'daily',
            protocol_version: 1,
            time_zone: 'UTC',
            interval: 1,
            day_of_month: null,
            day_of_week: null,
            month_of_year: null,
            start_date: '2026-08-01T08:30:00.000Z',
            end_date: null,
            last_generated_date: index === 0 ? '2026-08-31T14:22:00.000Z' : '2026-09-01T00:15:00.000Z',
            enabled: true,
          },
          scope,
        ),
        mutation('exchange_rate_override', rateId, timestamp, {
          base_currency: 'USD',
          quote_currency: 'CNY',
          rate: index === 0 ? '7.123456789012345678' : '7.2',
        }),
      ];
      batches.push(changes);
      acceptedIds.push((await push(session, changes)).map((outcome) => outcome.change_id));
      const events = await pull(session);
      const snapshot = await full(session, ledgerId);
      const rows = {
        category: snapshot.categories,
        recurring_transaction: snapshot.recurring_transactions,
        exchange_rate_override: snapshot.exchange_rate_overrides,
      };
      const stored = await Promise.all([
        prisma.category.findUniqueOrThrow({ where: { id_ownerId: { id: categoryId, ownerId: session.user.user_id } } }),
        prisma.recurringTransaction.findUniqueOrThrow({ where: { id: recurringId } }),
        prisma.exchangeRateOverride.findUniqueOrThrow({ where: { id: rateId } }),
      ]);
      for (const [position, change] of changes.entries()) {
        const event = events.find((item) => item.mutation_id === change.mutation_id)!;
        const record = rows[change.entity_type as keyof typeof rows].find((item) => item.id === change.entity_id);
        expect(event.payload).toEqual(record);
        expect(event.payload.id).toBe(change.entity_id);
        expect(event.payload.updated_at).toBe(stored[position]!.updatedAt.toISOString());
        expect(event.payload.updated_at).toBe(timestamp);
        expect(event.updated_at).toBe(timestamp);
      }
      expect(snapshot.categories.find((item) => item.id === categoryId)!.name).toBe(`分类${index}`);
      expect(snapshot.recurring_transactions[0]!.ledger_id).toBe(ledgerId);
      expect(snapshot.recurring_transactions[0]!).toMatchObject({
        start_date: '2026-08-01T08:30:00.000Z',
        last_generated_date: null,
      });
    }

    const beforeReplay = (await pull(session)).filter((event) => ids.includes(event.entity_id));
    for (const id of ids) {
      expect(beforeReplay.filter((event) => event.entity_id === id).map((event) => event.payload.updated_at)).toEqual(
        versions,
      );
    }
    const replayed = await push(session, batches[0]!, 'ignored');
    expect(replayed.map((outcome) => outcome.change_id)).toEqual(acceptedIds[0]);
    expect((await pull(session)).filter((event) => ids.includes(event.entity_id))).toEqual(beforeReplay);
    expect((await full(session, ledgerId)).categories.find((item) => item.id === categoryId)!.name).toBe('分类1');

    // 分类删除同步权威墓碑及版本令牌，其他实体按对应删除载荷表达身份。
    const deletions = batches[1]!.map((change) => ({
      ...change,
      mutation_id: randomUUID(),
      action: 'delete' as const,
      updated_at: '2026-09-01T02:00:00.000Z',
      payload: change.entity_type === 'exchange_rate_override' ? change.payload : {},
    }));
    const deleted = await push(session, deletions);
    const afterDelete = (await pull(session)).filter((event) => ids.includes(event.entity_id));
    for (const change of deletions) {
      const event = afterDelete.find((item) => item.mutation_id === change.mutation_id)!;
      expect(event.action).toBe('delete');
      if (change.entity_type === 'category') {
        expect(event.payload).toEqual({
          id: categoryId,
          owner_id: session.user.user_id,
          name: '分类1',
          kind: 'expense',
          level: 1,
          sort_order: 1,
          icon: null,
          parent_id: null,
          updated_at: change.updated_at,
          deleted_at: change.updated_at,
          version_token: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
      } else {
        expect(event.payload).toEqual(change.payload);
      }
    }
    const deletedSnapshot = await full(session, ledgerId);
    expect(deletedSnapshot.categories).toEqual(defaultCategories);
    expect(deletedSnapshot.categories.some((item) => item.id === categoryId)).toBe(false);
    expect(deletedSnapshot).toMatchObject({
      recurring_transactions: [],
      exchange_rate_overrides: [],
    });
    expect((await push(session, deletions, 'ignored')).map((outcome) => outcome.change_id)).toEqual(
      deleted.map((outcome) => outcome.change_id),
    );
    expect((await pull(session)).filter((event) => ids.includes(event.entity_id))).toEqual(afterDelete);
  } catch (cause) {
    throw new Error('同步权威载荷与版本重放回归失败', { cause });
  }
});

it('不同账号复用分类 ID 时，权威事件只包含当前账号保存的内容', async () => {
  try {
    const first = await register();
    const second = await register();
    const categoryId = randomUUID();
    const timestamp = '2026-09-01T00:00:00.000Z';
    for (const [index, session] of [first, second].entries()) {
      await push(session, [
        mutation('category', categoryId, timestamp, {
          name: `  私有分类${index}  `,
          kind: 'expense',
          level: 1,
          sort_order: 0,
          icon: null,
          parent_id: null,
        }),
      ]);
    }
    for (const [index, session] of [first, second].entries()) {
      const events = (await pull(session)).filter((event) => event.entity_id === categoryId);
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({ id: categoryId, name: `私有分类${index}`, updated_at: timestamp });
    }
  } catch (cause) {
    throw new Error('同步权威载荷的分类账号隔离回归失败', { cause });
  }
});

/** 创建真实共享关系，确认成员同步场景由 Editor 而不是 Owner 发起。 */
async function sharedLedger() {
  try {
    const owner = await register();
    const editor = await register();
    const ledgerId = randomUUID();
    const created = await api('POST', '/ledgers', owner, { id: ledgerId, name: '成员权威载荷账本' });
    expect(created.statusCode, created.body).toBe(201);
    const invited = await api('POST', `/ledgers/${ledgerId}/invites`, owner, {});
    expect(invited.statusCode, invited.body).toBe(201);
    const accepted = await api('POST', `/invites/${invited.json<{ code: string }>().code}/accept`, editor, {});
    expect(accepted.statusCode, accepted.body).toBe(200);
    return { owner, editor, ledgerId, syncId: created.json<{ sync_id: string }>().sync_id };
  } catch (cause) {
    throw new Error('成员权威载荷共享账本创建失败', { cause });
  }
}

it('Editor 的占位成员创建、更新和删除只发布数据库真实身份，伪造元数据不能撤销其他成员', async () => {
  try {
    const { owner, editor, ledgerId, syncId } = await sharedLedger();
    const memberId = randomUUID();
    const registeredBefore = await prisma.ledgerMember.findMany({
      where: { ledgerId, memberType: 'REGISTERED' },
      orderBy: { id: 'asc' },
    });
    const ledgerBefore = await prisma.ledger.findUniqueOrThrow({ where: { id: ledgerId } });
    const changes: SyncMutationEnvelope[] = [];
    for (const [index, action] of ['upsert', 'upsert', 'delete'].entries()) {
      const timestamp = `2026-09-01T0${index}:00:00.000Z`;
      const change = {
        ...mutation(
          'member',
          memberId,
          timestamp,
          {
            display_name: `  占位成员${index}  `,
            id: registeredBefore[0]!.id,
            ledger_id: randomUUID(),
            member_type: 'REGISTERED',
            linked_account_id: owner.user.user_id,
            role: 'owner',
            status: 'REMOVED',
            updated_at: '2099-01-01T00:00:00.000Z',
            deleted_at: '2099-01-01T00:00:00.000Z',
          },
          { ledger_id: ledgerId, sync_id: syncId },
        ),
        action: action as 'upsert' | 'delete',
      };
      changes.push(change);
      await push(editor, [change]);
      const stored = await prisma.ledgerMember.findUniqueOrThrow({ where: { id: memberId } });
      expect(stored).toMatchObject({
        ledgerId,
        memberType: 'PLACEHOLDER',
        linkedAccountId: null,
        role: 'editor',
        status: action === 'delete' ? 'REMOVED' : 'ACTIVE',
        displayName: `占位成员${Math.min(index, 1)}`,
        updatedAt: new Date(timestamp),
      });
      const events = (await pull(owner)).filter((event) => event.mutation_id === change.mutation_id);
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toEqual({
        id: memberId,
        ledger_id: ledgerId,
        display_name: stored.displayName,
        member_type: 'PLACEHOLDER',
        linked_account_id: null,
        role: 'editor',
        status: stored.status,
        updated_at: stored.updatedAt.toISOString(),
      });
      expect(events[0]!.action).toBe(action);
      expect(events[0]!.updated_at).toBe(timestamp);
      const snapshot = await full(owner, ledgerId);
      expect(events[0]!.payload).toMatchObject(snapshot.members.find((member) => member.id === memberId)!);
      const beforeReplay = await pull(owner);
      const replay = await push(editor, [change], 'ignored');
      expect(replay[0]!.change_id).toBe(events[0]!.change_id);
      expect(await pull(owner)).toEqual(beforeReplay);
    }
    expect(
      await prisma.ledgerMember.findMany({ where: { ledgerId, memberType: 'REGISTERED' }, orderBy: { id: 'asc' } }),
    ).toEqual(registeredBefore);
    expect(await prisma.ledger.findUniqueOrThrow({ where: { id: ledgerId } })).toEqual(ledgerBefore);
    // 创建结果已经终止后重放仍返回原事件，不重新激活占位成员。
    await push(editor, [changes[0]!], 'ignored');
    expect(await prisma.ledgerMember.findUniqueOrThrow({ where: { id: memberId } })).toMatchObject({
      status: 'REMOVED',
    });
  } catch (cause) {
    throw new Error('占位成员权威事件与生命周期回归失败', { cause });
  }
});

it('成员事件改用权威快照后，仍拒绝删除被交易引用的占位成员', async () => {
  try {
    const { owner, editor, ledgerId, syncId } = await sharedLedger();
    const memberId = randomUUID();
    const created = mutation(
      'member',
      memberId,
      '2026-09-01T00:00:00.000Z',
      { display_name: '付款人' },
      {
        ledger_id: ledgerId,
        sync_id: syncId,
      },
    );
    await push(editor, [created]);
    const transaction = await api('POST', `/ledgers/${ledgerId}/transactions`, editor, {
      id: randomUUID(),
      tx_type: 'expense',
      amount: '10',
      native_amount: '10',
      currency_code: 'CNY',
      happened_at: '2026-09-01T00:00:00.000Z',
      payer_member_id: memberId,
    });
    expect(transaction.statusCode, transaction.body).toBe(201);
    const before = await pull(owner);
    const rejected = await api('POST', '/sync/push', editor, {
      device_id: editor.device_id,
      changes: [
        {
          ...created,
          mutation_id: randomUUID(),
          action: 'delete',
          updated_at: '2026-09-01T01:00:00.000Z',
          payload: {},
        },
      ],
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json()).toMatchObject({
      outcomes: [
        { status: 'invalid', change_id: null, code: 'MEMBER_IN_USE', message: '该成员仍被交易引用，无法删除' },
      ],
    });
    expect(await prisma.ledgerMember.findUniqueOrThrow({ where: { id: memberId } })).toMatchObject({
      status: 'ACTIVE',
    });
    expect(await pull(owner)).toEqual(before);
  } catch (cause) {
    throw new Error('占位成员历史交易引用保护回归失败', { cause });
  }
});

it('账本事件只包含已保存的名称与身份，删除时间和同步控制字段不能由 payload 伪造', async () => {
  try {
    const owner = await register();
    const ledgerId = randomUUID();
    let syncId: string | undefined;
    const changes: SyncMutationEnvelope[] = [];
    for (const [index, action] of ['upsert', 'upsert', 'delete'].entries()) {
      const timestamp = `2026-09-01T0${index}:00:00.000Z`;
      const change = {
        ...mutation(
          'ledger',
          ledgerId,
          timestamp,
          {
            name: `  权威账本${index}  `,
            currency: 'CNY',
            month_start_day: 1,
            aa_enabled: false,
            id: randomUUID(),
            sync_id: randomUUID(),
            updated_at: '2099-01-01T00:00:00.000Z',
            deleted_at: '2099-01-01T00:00:00.000Z',
            requires_full: true,
            role: 'editor',
            member_count: 999,
          },
          { ledger_id: ledgerId, sync_id: syncId },
        ),
        action: action as 'upsert' | 'delete',
      };
      changes.push(change);
      await push(owner, [change]);
      const stored = await prisma.ledger.findUniqueOrThrow({ where: { id: ledgerId } });
      syncId = stored.syncId;
      const event = (await pull(owner)).find((item) => item.mutation_id === change.mutation_id)!;
      expect(event.payload).toEqual({
        id: ledgerId,
        owner_id: stored.ownerId,
        sync_id: stored.syncId,
        name: `权威账本${Math.min(index, 1)}`,
        currency: 'CNY',
        month_start_day: 1,
        aa_enabled: false,
        updated_at: stored.updatedAt.toISOString(),
        ...(action === 'delete' ? { deleted_at: stored.deletedAt!.toISOString() } : {}),
      });
      expect(event.updated_at).toBe(timestamp);
      expect(stored.updatedAt.toISOString()).toBe(timestamp);
      if (action === 'upsert') expect((await full(owner, ledgerId)).ledger).toMatchObject(event.payload);
      else expect(stored.deletedAt!.toISOString()).toBe(timestamp);
    }
    const beforeReplay = await pull(owner);
    for (const change of changes) await push(owner, [change], 'ignored');
    expect(await pull(owner)).toEqual(beforeReplay);
    expect(await prisma.ledger.findUniqueOrThrow({ where: { id: ledgerId } })).toMatchObject({
      deletedAt: new Date('2026-09-01T02:00:00.000Z'),
    });
  } catch (cause) {
    throw new Error('账本权威事件与墓碑载荷回归失败', { cause });
  }
});
