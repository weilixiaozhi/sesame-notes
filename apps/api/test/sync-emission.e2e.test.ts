import { accountingRequestFixturePath } from './accounting-request-fixture.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { SYNC_ENTITY_TYPES } from '../src/shared/contracts/sync.js';
import type { SyncMutationEnvelope } from '../src/shared/sync-mutation.js';
import { exchangeRateOverrideId } from '../src/modules/accounting/index.js';
import { fitnessTemplate, fitnessPlan, fitnessWorkout, fitnessPreferences, fitnessTime } from './fitness-fixtures.js';

const databaseUrl = testFixtureDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = buildApp({
  prisma,
  logger: false,
  config: loadConfig({
    DATABASE_URL: databaseUrl,
    JWT_SECRET: 'sync-emission-test-secret-at-least-32-bytes',
    STORAGE_PATH: process.env.STORAGE_PATH ?? resolve(import.meta.dirname, '../../../Temp/sync-emission'),
    RATE_LIMIT_MAX: '10000',
    AUTH_RATE_LIMIT_MAX: '10000',
  }),
});
type Session = { access_token: string; device_id: string; user: { user_id: string } };
type Event = {
  change_id: string;
  entity_type: string;
  entity_id: string;
  mutation_id: string;
  action: string;
  payload: Record<string, unknown>;
};
beforeAll(() => app.ready());
afterAll(() => app.close());

/** 创建真实会话，所有被验收的业务实体都通过HTTP写入。 */
async function register(): Promise<Session> {
  try {
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        country_code: '+86',
        phone: `139${randomInt(100000000).toString().padStart(8, '0')}`,
        password: 'emission-test-password',
        device: { installation_id: randomUUID(), name: 'emission-test', platform: 'test' },
      },
    });
    expect(result.statusCode, result.body).toBe(201);
    return result.json();
  } catch (cause) {
    throw new Error('同步读回测试注册失败', { cause });
  }
}

/** 所有读取都经过增量协议及权限过滤，不能仅用数据库日志存在代替客户端可见。 */
async function pull(session: Session, since = '0'): Promise<Event[]> {
  try {
    const result = await app.inject({
      method: 'GET',
      url: `/api/v1/sync/pull?since=${since}&limit=1000`,
      headers: { authorization: `Bearer ${session.access_token}` },
    });
    expect(result.statusCode, result.body).toBe(200);
    return result.json<{ changes: Event[] }>().changes;
  } catch (cause) {
    throw new Error('同步事件读取失败', { cause });
  }
}

/** 每个首次接受的mutation必须被pull读取；重放不得增加事件或改变已提交身份。 */
async function pushAndObserve(session: Session, mutation: SyncMutationEnvelope) {
  try {
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/sync/push',
        headers: { authorization: `Bearer ${session.access_token}` },
        payload: { device_id: session.device_id, changes: [mutation] },
      });
    const response = await send();
    expect(response.statusCode, response.body).toBe(200);
    const outcome = response.json().outcomes[0] as {
      status: string;
      change_id: string;
      sync_id?: string;
      revision?: number;
    };
    expect(outcome.status, response.body).toBe('accepted');
    const events = await pull(session);
    expect(events.filter((event) => event.mutation_id === mutation.mutation_id)).toEqual([
      expect.objectContaining({
        entity_type: mutation.entity_type,
        entity_id: mutation.entity_id,
        action: mutation.action,
        change_id: outcome.change_id,
      }),
    ]);
    const replay = await send();
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().outcomes[0]).toMatchObject({ status: 'ignored', change_id: outcome.change_id });
    expect((await pull(session)).filter((event) => event.mutation_id === mutation.mutation_id)).toHaveLength(1);
    return outcome;
  } catch (cause) {
    throw new Error(`同步实体 ${mutation.entity_type} 写入读回失败`, { cause });
  }
}

/** 构造冻结同步请求，父本身份由本轮真实服务器响应提供。 */
function change(
  type: string,
  id: string,
  payload: Record<string, unknown>,
  scope: Partial<SyncMutationEnvelope> = {},
): SyncMutationEnvelope {
  return {
    mutation_id: randomUUID(),
    entity_type: type,
    entity_id: id,
    ledger_id: null,
    day_book_id: null,
    memo_book_id: null,
    fitness_space_id: null,
    action: 'upsert',
    updated_at: fitnessTime,
    payload,
    ...scope,
  };
}

it('协议全集的每种实体写入都可pull读回，重放不会重复发事件', async () => {
  const session = await register();
  const covered = new Set<string>();
  const write = async (mutation: SyncMutationEnvelope) => {
    const outcome = await pushAndObserve(session, mutation);
    covered.add(mutation.entity_type);
    return outcome;
  };
  const ledgerId = randomUUID();
  const ledger = await write(
    change(
      'ledger',
      ledgerId,
      { name: '门禁账本', currency: 'CNY', month_start_day: 1, aa_enabled: false },
      { ledger_id: ledgerId },
    ),
  );
  const ledgerScope = { ledger_id: ledgerId, sync_id: ledger.sync_id };
  await write(change('ledger_archive', ledgerId, { archived: true }, ledgerScope));
  const categoryId = randomUUID();
  await write(
    change('category', categoryId, {
      name: '门禁分类',
      kind: 'expense',
      level: 1,
      sort_order: 0,
      icon: null,
      parent_id: null,
    }),
  );
  await write(
    change(
      'recurring_transaction',
      randomUUID(),
      {
        tx_type: 'expense',
        amount: '1',
        currency_code: 'CNY',
        category_id: categoryId,
        note: null,
        frequency: 'monthly',
        protocol_version: 1,
        time_zone: 'UTC',
        interval: 1,
        day_of_month: 1,
        day_of_week: null,
        month_of_year: null,
        start_date: fitnessTime,
        end_date: null,
        last_generated_date: null,
        enabled: true,
      },
      ledgerScope,
    ),
  );
  await write(
    change('exchange_rate_override', exchangeRateOverrideId(session.user.user_id, 'USD', 'CNY'), {
      base_currency: 'USD',
      quote_currency: 'CNY',
      rate: '7',
    }),
  );
  await write(change('member', randomUUID(), { display_name: '占位成员' }, ledgerScope));
  await write(
    change(
      'transaction',
      randomUUID(),
      {
        tx_type: 'expense',
        amount: '1',
        happened_at: fitnessTime,
        note: null,
        category_id: categoryId,
        currency_code: 'CNY',
        native_amount: '1',
        recurring_id: null,
        aa_mode: null,
        splits: null,
        last_edited_at: null,
      },
      ledgerScope,
    ),
  );
  const dayId = randomUUID();
  const day = await write(change('day_book', dayId, { name: '日子', created_at: fitnessTime }, { day_book_id: dayId }));
  await write(
    change(
      'day_event',
      randomUUID(),
      {
        name: '纪念日',
        category: 'anniversary',
        countdown_mode: null,
        interval_days: null,
        repeat_type: 'yearly',
        statistic_type: 'day',
        event: {
          calendar_type: 'solar',
          original_year: 2026,
          original_month: 9,
          original_day: 11,
          is_leap_month: false,
          solar_date: '2026-09-11',
        },
        start: null,
        end: null,
        created_at: fitnessTime,
      },
      { day_book_id: dayId, sync_id: day.sync_id },
    ),
  );
  const memoId = randomUUID();
  const memo = await write(
    change(
      'memo_book',
      memoId,
      { name: '备忘录', type: 'normal', created_at: fitnessTime, updated_at: fitnessTime },
      { memo_book_id: memoId },
    ),
  );
  await write(
    change(
      'memo_entry',
      randomUUID(),
      {
        book_type: 'normal',
        title: '笔记',
        body_format: 'delta_v1',
        body: { ops: [{ insert: '正文\n' }] },
        order_key: null,
        created_at: fitnessTime,
        updated_at: fitnessTime,
      },
      { memo_book_id: memoId, sync_id: memo.sync_id },
    ),
  );
  const spaceId = randomUUID();
  const space = await write(
    change(
      'fitness_space',
      spaceId,
      { name: '健身', created_at: fitnessTime, updated_at: fitnessTime },
      { fitness_space_id: spaceId },
    ),
  );
  for (const [type, payload] of [
    ['fitness_template', fitnessTemplate()],
    ['fitness_plan', fitnessPlan()],
    ['fitness_workout', fitnessWorkout()],
    ['fitness_preferences', fitnessPreferences()],
  ] as const) {
    await write(
      change(type, type === 'fitness_preferences' ? spaceId : randomUUID(), payload, {
        fitness_space_id: spaceId,
        sync_id: space.sync_id,
      }),
    );
  }
  expect([...covered].sort()).toEqual([...SYNC_ENTITY_TYPES].sort());
}, 20000);

it('REST新增修改删除和批量导入产生可读事件，非法批量写入整体回滚', async () => {
  const session = await register();
  const headers = { authorization: `Bearer ${session.access_token}` };
  const request = async (method: 'POST' | 'PATCH' | 'DELETE', path: string, payload?: Record<string, unknown>) =>
    app.inject({
      method,
      url: await accountingRequestFixturePath(app, method, `/api/v1${path}`, headers),
      headers,
      payload,
    });
  const ledger = await request('POST', '/ledgers', {
    name: 'REST门禁',
    currency: 'CNY',
    month_start_day: 1,
    aa_enabled: false,
  });
  expect(ledger.statusCode, ledger.body).toBe(201);
  const ledgerId = ledger.json().id as string;
  const transactionId = randomUUID();
  const payload = {
    id: transactionId,
    tx_type: 'expense',
    amount: '1',
    happened_at: fitnessTime,
    currency_code: 'CNY',
    native_amount: '1',
  };
  const create = await request('POST', `/ledgers/${ledgerId}/transactions`, payload);
  expect(create.statusCode, create.body).toBe(201);
  const update = await request('PATCH', `/ledgers/${ledgerId}/transactions/${transactionId}`, {
    base_revision: 1,
    note: '修改',
  });
  expect(update.statusCode, update.body).toBe(200);
  const remove = await request('DELETE', `/ledgers/${ledgerId}/transactions/${transactionId}`, { base_revision: 2 });
  expect(remove.statusCode, remove.body).toBe(204);
  expect(
    (await pull(session)).filter((event) => event.entity_id === transactionId).map((event) => event.action),
  ).toEqual(['upsert', 'upsert', 'delete']);
  const importedId = randomUUID();
  const imported = await request('POST', `/ledgers/${ledgerId}/imports`, {
    transactions: [{ ...payload, id: importedId }],
  });
  expect(imported.statusCode, imported.body).toBe(201);
  expect(await pull(session)).toContainEqual(
    expect.objectContaining({ entity_id: importedId, entity_type: 'transaction' }),
  );
  const rollbackId = randomUUID();
  const failed = await request('POST', `/ledgers/${ledgerId}/imports`, {
    transactions: [
      { ...payload, id: rollbackId },
      { ...payload, id: randomUUID(), category_id: randomUUID() },
    ],
  });
  expect(failed.statusCode).toBe(400);
  expect(await prisma.transaction.findUnique({ where: { id: rollbackId } })).toBeNull();
  expect((await pull(session)).some((event) => event.entity_id === rollbackId)).toBe(false);
  expect((await request('DELETE', `/ledgers/${ledgerId}`)).statusCode).toBe(204);
  expect(await pull(session)).toContainEqual(
    expect.objectContaining({ entity_id: ledgerId, entity_type: 'ledger', action: 'delete' }),
  );
}, 15000);
