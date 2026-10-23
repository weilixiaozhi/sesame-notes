import { testStoragePath } from './test-storage-path.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';

const databaseUrl = testFixtureDatabaseUrl();
const config: ApiConfig = {
  databaseUrl,
  jwtSecret: 'memos-test-secret-at-least-32-bytes-long',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2592000,
  storagePath: testStoragePath('memos-sync'),
  exchangeRateUpstream: 'https://api.frankfurter.dev',
  exchangeRateCacheTtlSeconds: 43200,
  githubReleaseToken: '',
  port: 8080,
  host: '127.0.0.1',
  corsOrigins: [],
  rateLimitMax: 1000,
  authRateLimitMax: 1000,
  syncRetentionMinCursor: 0,
  trustProxyCidrs: [],
};
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = buildApp({ logger: false, config, prisma });
type Session = { access_token: string; device_id: string; phone: string };
const time = '2026-09-08T01:02:03.789Z';
beforeAll(() => app.ready());
afterAll(() => app.close());

/** 创建本测试独享账号，手机号仅用于第二设备验证同账号同步。 */
async function register(): Promise<Session> {
  const phone = `139${randomInt(100_000_000).toString().padStart(8, '0')}`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      country_code: '+86',
      phone,
      password: 'memos-test-password',
      device: { installation_id: randomUUID(), name: 'memos-test', platform: 'test' },
    },
  });
  expect(response.statusCode).toBe(201);
  return { ...response.json(), phone };
}

/** 第二设备独立登录，使用自己的会话读取第一设备的排序事件。 */
async function peerSession(owner: Session): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: {
      country_code: '+86',
      phone: owner.phone,
      password: 'memos-test-password',
      device: { installation_id: randomUUID(), name: 'memos-peer', platform: 'test' },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return { ...response.json(), phone: owner.phone };
}
function change(bookId: string, options: Record<string, unknown> = {}) {
  return {
    mutation_id: randomUUID(),
    entity_type: 'memo_book',
    entity_id: bookId,
    ledger_id: null,
    day_book_id: null,
    memo_book_id: bookId,
    action: 'upsert',
    updated_at: time,
    payload: { name: '本', type: 'normal', created_at: time, updated_at: time },
    ...options,
  };
}
async function push(session: Session, mutation: Record<string, unknown>) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/sync/push',
    headers: { authorization: `Bearer ${session.access_token}` },
    payload: { device_id: session.device_id, changes: [mutation] },
  });
  return { status: response.statusCode, body: response.json() };
}
async function get(session: Session, path: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/sync/${path}`,
    headers: { authorization: `Bearer ${session.access_token}` },
  });
}
it('两类型、原始字符、毫秒时间、CAS、重放、私有 full 与删除水位', async () => {
  const owner = await register();
  const stranger = await register();
  const rejected = await push(
    owner,
    change(randomUUID(), {
      payload: { name: '本', type: 'diary', created_at: time, updated_at: time },
    }),
  );
  expect(rejected.status).toBe(400);
  for (const type of ['normal', 'credentials']) {
    const bookId = randomUUID();
    const create = change(bookId, { payload: { name: '同名', type, created_at: time, updated_at: time } });
    const created = await push(owner, create);
    expect(created.status).toBe(200);
    expect(created.body.outcomes[0].status).toBe('accepted');
    const syncId = created.body.outcomes[0].sync_id;
    expect((await push(owner, create)).body.outcomes[0].status).toBe('ignored');
    const isCard = type === 'credentials';
    const payload = {
      book_type: type,
      title: isCard ? '卡片' : '',
      body_format: isCard ? 'fields_v1' : 'delta_v1',
      body: isCard
        ? {
            fields: [
              { label: '登录用户名', value: ' \u0000用户 ' },
              { label: '支付密码', value: '\u0000 🔑\t\n ' },
              { label: '空值字段', value: '' },
            ],
          }
        : { ops: [{ insert: '  中文😀é\u0000\n\n' }] },
      order_key: isCard ? '9007199254740993' : null,
      created_at: time,
      updated_at: time,
    };
    const entryId = randomUUID();
    const mutation = change(bookId, { entity_id: entryId, entity_type: 'memo_entry', sync_id: syncId, payload });
    const saved = await push(owner, mutation);
    expect(saved.status).toBe(200);
    expect(saved.body.outcomes[0].status, saved.body.outcomes[0].message).toBe('accepted');
    expect((await push(owner, mutation)).body.outcomes[0].revision).toBe(1);
    const full = await get(owner, `memo-books/full?memo_book_id=${bookId}&sync_id=${syncId}`);
    expect(full.statusCode).toBe(200);
    expect(full.json().memo_entries[0]).toMatchObject(payload);
    expect(full.json().memo_book.revision).toBe(1);
    expect((await get(stranger, `memo-books/full?memo_book_id=${bookId}`)).statusCode).toBe(404);
    const edited = await push(owner, {
      ...mutation,
      mutation_id: randomUUID(),
      base_revision: 1,
      payload: { ...payload, title: '已编辑' },
    });
    expect(edited.body.outcomes[0].revision).toBe(2);
    const conflict = await push(owner, { ...mutation, mutation_id: randomUUID(), base_revision: 1 });
    expect(conflict.body.outcomes[0]).toMatchObject({ status: 'conflict', current_revision: 2 });
    const staleDelete = await push(
      owner,
      change(bookId, {
        action: 'delete',
        sync_id: syncId,
        base_revision: 1,
        payload: { expected_full_cursor: full.json().server_cursor },
      }),
    );
    expect(staleDelete.body.outcomes[0].status).toBe('invalid');
    const fresh = await get(owner, `memo-books/full?memo_book_id=${bookId}`);
    const deleted = await push(
      owner,
      change(bookId, {
        action: 'delete',
        sync_id: syncId,
        base_revision: 1,
        payload: { expected_full_cursor: fresh.json().server_cursor },
      }),
    );
    expect(deleted.body.outcomes[0].status).toBe('accepted');
    expect((await get(owner, `memo-books/full?memo_book_id=${bookId}`)).statusCode).toBe(404);
    expect((await prisma.memoEntry.findUniqueOrThrow({ where: { id: entryId } })).deletedAt).not.toBeNull();
  }
  expect((await get(stranger, 'memo-books')).json().memo_books).toEqual([]);
});

it.each(['normal', 'credentials'])(
  '%s 标题和正文中的真实 NUL 与字面转义在创建、修改和同步读取时逐字保留',
  async (type) => {
    try {
      const owner = await register();
      const bookId = randomUUID();
      const created = await push(
        owner,
        change(bookId, { payload: { name: '原始标题', type, created_at: time, updated_at: time } }),
      );
      expect(created.status).toBe(200);
      expect(created.body.outcomes[0].status).toBe('accepted');
      const syncId = created.body.outcomes[0].sync_id;
      const entryId = randomUUID();
      const titles =
        type === 'normal'
          ? ['首行\u0000与字面\\u0000😀', '修改\u0000后仍有\\u0000']
          : ['  账号\u0000标题\\u0000  ', '\t新卡片\u0000与\\u0000\n'];
      const expectedEvents: Array<{ title: string; body: unknown; updated_at: string }> = [];
      for (const [index, title] of titles.entries()) {
        // 普通笔记的标题模拟正文首行自动摘要，卡片标题则保留用户输入的全部空白。
        const body =
          type === 'normal'
            ? { ops: [{ insert: `${title}\n原始正文\u0000与字面\\u0000\n` }] }
            : { fields: [{ label: '密码', value: '真实\u0000与字面\\u0000' }] };
        const updatedAt = index === 0 ? time : '2026-09-08T01:03:04.567Z';
        const payload = {
          book_type: type,
          title,
          body_format: type === 'normal' ? 'delta_v1' : 'fields_v1',
          body,
          order_key: type === 'normal' ? null : '9007199254740993',
          created_at: time,
          updated_at: updatedAt,
        };
        const mutation = change(bookId, {
          entity_type: 'memo_entry',
          entity_id: entryId,
          sync_id: syncId,
          base_revision: index,
          updated_at: updatedAt,
          payload,
        });
        const saved = await push(owner, mutation);
        expect(saved.status).toBe(200);
        expect(saved.body.outcomes[0]).toMatchObject({ status: 'accepted', revision: index + 1 });
        const row = await prisma.memoEntry.findUniqueOrThrow({ where: { id: entryId } });
        expect(row.title).toBe(title);
        expect(row.body).toEqual(body);
        expect(row.createdAt.toISOString()).toBe(time);
        expect(row.updatedAt.toISOString()).toBe(updatedAt);
        const snapshot = await get(owner, `memo-books/full?memo_book_id=${bookId}`);
        expect(snapshot.statusCode).toBe(200);
        expect(snapshot.json().memo_entries).toEqual([expect.objectContaining(payload)]);
        const pulled = await get(owner, 'pull?since=0&limit=1000');
        expect(pulled.statusCode).toBe(200);
        expectedEvents.push({ title, body, updated_at: updatedAt });
        const events = pulled
          .json<{ changes: Array<{ entity_id: string; payload: Record<string, unknown> }> }>()
          .changes.filter((event) => event.entity_id === entryId);
        expect(
          events.map((event) => ({
            title: event.payload.title,
            body: event.payload.body,
            updated_at: event.payload.updated_at,
          })),
        ).toEqual(expectedEvents);
        expect((await push(owner, mutation)).body.outcomes[0]).toMatchObject({
          status: 'ignored',
          revision: index + 1,
        });
      }
      for (const invalid of [null, true, 30, [], {}]) {
        await expect(prisma.$executeRaw`
        UPDATE memo_entries SET title = ${JSON.stringify(invalid)}::json WHERE id = ${entryId}::uuid
      `).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
      }
      expect(await prisma.memoEntry.findUniqueOrThrow({ where: { id: entryId } })).toMatchObject({
        title: titles[1],
        revision: 2,
      });
    } catch (cause) {
      throw new Error(`${type} 备忘录标题原始字符回归失败`, { cause });
    }
  },
);

it('整本恢复校验 full 水位，生成新绑定，同 ID 子项保留源时间并拒绝旧代请求', async () => {
  const owner = await register();
  const bookId = randomUUID();
  const created = await push(owner, change(bookId));
  const oldSync = created.body.outcomes[0].sync_id;
  const id = randomUUID();
  const payload = {
    book_type: 'normal',
    title: 'original',
    body_format: 'delta_v1',
    body: { ops: [{ insert: '内容\n' }] },
    order_key: null,
    created_at: time,
    updated_at: time,
  };
  const entry = change(bookId, { entity_type: 'memo_entry', entity_id: id, sync_id: oldSync, payload });
  expect((await push(owner, entry)).body.outcomes[0].status).toBe('accepted');
  const full = (await get(owner, `memo-books/full?memo_book_id=${bookId}`)).json();
  const restoredTime = '2020-01-02T03:04:05.006Z';
  const restore = change(bookId, {
    sync_id: oldSync,
    base_revision: 1,
    payload: {
      name: '恢复本',
      type: 'normal',
      created_at: restoredTime,
      updated_at: restoredTime,
      restore: true,
      expected_full_cursor: full.server_cursor,
    },
  });
  const result = await push(owner, restore);
  expect(result.body.outcomes[0].status).toBe('accepted');
  const newSync = result.body.outcomes[0].sync_id;
  expect(newSync).not.toBe(oldSync);
  expect((await push(owner, restore)).body.outcomes[0]).toMatchObject({ status: 'ignored', sync_id: newSync });
  expect((await get(owner, `memo-books/full?memo_book_id=${bookId}&sync_id=${oldSync}`)).statusCode).toBe(412);
  const old = await push(owner, { ...entry, mutation_id: randomUUID(), base_revision: 1 });
  expect(old.status === 412 || old.body.outcomes?.[0]?.status === 'invalid').toBe(true);
  expect(
    (
      await push(owner, {
        ...entry,
        mutation_id: randomUUID(),
        sync_id: newSync,
        payload: { ...payload, created_at: restoredTime, updated_at: restoredTime },
      })
    ).body.outcomes[0].status,
  ).toBe('accepted');
  const after = (await get(owner, `memo-books/full?memo_book_id=${bookId}&sync_id=${newSync}`)).json();
  expect(after.memo_entries).toHaveLength(1);
  expect(after.memo_entries[0]).toMatchObject({ id, created_at: restoredTime, updated_at: restoredTime, revision: 1 });
  expect(after.memo_book.created_at).toBe(restoredTime);
});

it('账号密码卡片支持自定义字段名、增删字段与空值，拒绝无内容卡片', async () => {
  const owner = await register();
  const bookId = randomUUID();
  const created = await push(
    owner,
    change(bookId, { payload: { name: '账号密码', type: 'credentials', created_at: time, updated_at: time } }),
  );
  const syncId = created.body.outcomes[0].sync_id;
  const entryId = randomUUID();
  const card = (payload: Record<string, unknown>, baseRevision: number) =>
    change(bookId, {
      entity_type: 'memo_entry',
      entity_id: entryId,
      sync_id: syncId,
      base_revision: baseRevision,
      payload: { book_type: 'credentials', order_key: '0', created_at: time, updated_at: time, ...payload },
    });
  const cardBody = (fields: Array<{ label: string; value: string }>) => ({
    body_format: 'fields_v1',
    body: { fields },
  });
  // 只记一个账号、同一字段名重复出现、字段值为空串都合法。
  const onlyAccount = await push(
    owner,
    card({ title: '', ...cardBody([{ label: '登录邮箱', value: 'mail@example.com' }]) }, 0),
  );
  expect(onlyAccount.body.outcomes[0].status, onlyAccount.body.outcomes[0].message).toBe('accepted');
  const duplicated = await push(
    owner,
    card(
      {
        title: '',
        ...cardBody([
          { label: '账号', value: 'first' },
          { label: '账号', value: 'second' },
          { label: '支付密码', value: '' },
        ]),
      },
      1,
    ),
  );
  expect(duplicated.body.outcomes[0].status, duplicated.body.outcomes[0].message).toBe('accepted');
  // 只填名称、一个字段都不加也合法。
  const titleOnly = await push(owner, card({ title: '仅名称', ...cardBody([]) }, 2));
  expect(titleOnly.body.outcomes[0].status, titleOnly.body.outcomes[0].message).toBe('accepted');
  // 名称与字段同时为空、字段名不可见、普通本使用 fields_v1 都必须被拒绝。
  const rejected = [
    card({ title: '', ...cardBody([]) }, 3),
    card({ title: 'x', ...cardBody([{ label: '  ', value: 'v' }]) }, 3),
    card({ title: 'x', ...cardBody([{ label: '账号', value: 'v' }]), book_type: 'normal', order_key: null }, 3),
  ];
  for (const mutation of rejected) {
    const outcome = await push(owner, mutation);
    expect(outcome.body.outcomes[0].status).toBe('invalid');
  }
  const full = (await get(owner, `memo-books/full?memo_book_id=${bookId}&sync_id=${syncId}`)).json();
  expect(full.memo_entries).toHaveLength(1);
  expect(full.memo_entries[0]).toMatchObject({
    title: '仅名称',
    body_format: 'fields_v1',
    body: { fields: [] },
    order_key: '0',
  });
});

it('卡片排序遵守版本校验，保留正文和创建时间并同步第二设备', async () => {
  try {
    const owner = await register();
    const peer = await peerSession(owner);
    const bookId = randomUUID();
    const created = await push(
      owner,
      change(bookId, {
        payload: { name: '排序本', type: 'credentials', created_at: time, updated_at: time },
      }),
    );
    const syncId = created.body.outcomes[0].sync_id;
    const entryId = randomUUID();
    const otherId = randomUUID();
    const payload = {
      book_type: 'credentials',
      title: '卡片正文保持原值',
      body_format: 'fields_v1',
      body: {
        fields: [
          { label: '账号', value: 'synthetic@example.com' },
          { label: '密码', value: '合成测试值' },
        ],
      },
      order_key: '9007199254740993',
      created_at: time,
      updated_at: time,
    };
    for (const [id, key] of [
      [entryId, payload.order_key],
      [otherId, '100'],
    ]) {
      const result = await push(
        owner,
        change(bookId, {
          entity_type: 'memo_entry',
          entity_id: id,
          sync_id: syncId,
          payload: { ...payload, order_key: key },
        }),
      );
      expect(result.body.outcomes[0]).toMatchObject({ status: 'accepted', revision: 1 });
    }
    const before = await prisma.memoEntry.findUniqueOrThrow({ where: { id: entryId } });
    const full = await get(peer, `memo-books/full?memo_book_id=${bookId}`);
    expect(full.json().memo_entries.map((row: { id: string }) => row.id)).toEqual([otherId, entryId]);
    const updatedAt = '2026-09-09T01:02:03.789Z';
    const reordered = change(bookId, {
      entity_type: 'memo_entry',
      entity_id: entryId,
      sync_id: syncId,
      base_revision: 1,
      updated_at: updatedAt,
      payload: { ...payload, order_key: '0', updated_at: updatedAt },
    });
    const saved = await push(owner, reordered);
    expect(saved.body.outcomes[0]).toMatchObject({ status: 'accepted', revision: 2 });
    const after = await prisma.memoEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(after).toEqual({ ...before, orderKey: 0n, updatedAt: new Date(updatedAt), revision: 2 });
    expect((await push(owner, reordered)).body.outcomes[0]).toMatchObject({ status: 'ignored', revision: 2 });

    // 旧版本的另一设备不能覆盖已保存顺序，冲突快照返回当前顺序供重新确认。
    const stale = await push(peer, {
      ...reordered,
      mutation_id: randomUUID(),
      payload: { ...payload, order_key: '50' },
    });
    expect(stale.body.outcomes[0]).toMatchObject({
      status: 'conflict',
      current_revision: 2,
      current_entity: { order_key: '0', created_at: time, body: payload.body },
    });
    const modifiedIdentity = await push(owner, {
      ...reordered,
      mutation_id: randomUUID(),
      base_revision: 2,
      payload: { ...payload, order_key: '50', created_at: updatedAt },
    });
    expect(modifiedIdentity.body.outcomes[0]).toMatchObject({ status: 'invalid', code: 'MEMO_IDENTITY_IMMUTABLE' });
    expect(await prisma.memoEntry.findUniqueOrThrow({ where: { id: entryId } })).toEqual(after);

    const pulled = await get(peer, `pull?since=${full.json().server_cursor}&limit=1000`);
    expect(pulled.statusCode, pulled.body).toBe(200);
    const entries = pulled.json().changes.filter((row: { entity_type: string }) => row.entity_type === 'memo_entry');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entity_id: entryId,
      payload: { ...payload, order_key: '0', updated_at: updatedAt, revision: 2 },
    });
    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/memo-books/${bookId}/entries`,
      headers: { authorization: `Bearer ${peer.access_token}` },
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().items.map((row: { id: string }) => row.id)).toEqual([entryId, otherId]);
    expect(
      (await get(peer, `memo-books/full?memo_book_id=${bookId}`))
        .json()
        .memo_entries.map((row: { id: string }) => row.id),
    ).toEqual([entryId, otherId]);
  } catch (cause) {
    throw new Error('卡片排序跨设备同步验证失败', { cause });
  }
});

it('普通备忘录只接受空顺序号，不能转成卡片排序记录', async () => {
  try {
    const owner = await register();
    const bookId = randomUUID();
    const book = await push(owner, change(bookId));
    const entryId = randomUUID();
    const payload = {
      book_type: 'normal',
      title: '普通笔记',
      body_format: 'delta_v1',
      body: { ops: [{ insert: '正文\n' }] },
      order_key: null,
      created_at: time,
      updated_at: time,
    };
    const mutation = change(bookId, {
      entity_type: 'memo_entry',
      entity_id: entryId,
      sync_id: book.body.outcomes[0].sync_id,
      payload,
    });
    expect((await push(owner, mutation)).body.outcomes[0]).toMatchObject({ status: 'accepted', revision: 1 });
    const before = await prisma.memoEntry.findUniqueOrThrow({ where: { id: entryId } });
    const rejected = await push(owner, {
      ...mutation,
      mutation_id: randomUUID(),
      base_revision: 1,
      payload: { ...payload, order_key: '0' },
    });
    expect(rejected.body.outcomes[0]).toMatchObject({ status: 'invalid', code: 'INVALID_MEMO_NOTE' });
    expect(await prisma.memoEntry.findUniqueOrThrow({ where: { id: entryId } })).toEqual(before);
  } catch (cause) {
    throw new Error('普通备忘录顺序约束验证失败', { cause });
  }
});
