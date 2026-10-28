/**
 * 请通过仓库根目录的 node scripts/dev/long-term-server-acceptance.mjs 运行。
 * 本探针依赖已安装的项目工具和 PostgreSQL，仅接受驱动器设置的显式隔离测试目标与 Temp 输出目录。
 * seed 生成 1、5、10 年合成数据并执行真实 API/数据库路径；verify 核对新数据库还原后的重连。
 * 首次上传与单条增量写入各采样一次，其余各读取路径采样三次；API 耗时不代表手机/UI/公网耗时。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { inspect } from 'node:util';
import sharp from 'sharp';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { uuidV5 } from '../src/shared/uuid.js';
import { guardedTestDatabaseUrl } from '../test/existing-test-database.js';
import { fitnessWorkout, fitnessPreferences } from '../test/fitness-fixtures.js';

const databaseUrl = guardedTestDatabaseUrl(process.env.E2E_DATABASE_URL, process.env);
const output = process.env.LONG_TERM_OUTPUT!;
assert(output && path.isAbsolute(output) && output.includes(`${path.sep}Temp${path.sep}long-term-server-`));
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const start = performance.now();
const app = buildApp({
  logger: false,
  prisma,
  config: {
    databaseUrl,
    jwtSecret: 'long-term-synthetic-secret-at-least-32-bytes',
    accessTokenTtlSeconds: 7200,
    refreshTokenTtlSeconds: 2592000,
    storagePath: path.join(output, 'storage'),
    exchangeRateUpstream: 'https://invalid.example',
    exchangeRateCacheTtlSeconds: 43200,
    githubReleaseToken: '',
    port: 0,
    host: '127.0.0.1',
    corsOrigins: [],
    rateLimitMax: 100000,
    authRateLimitMax: 10000,
    syncRetentionMinCursor: 0,
    trustProxyCidrs: [],
  },
});
type Value = Record<string, any>;
const namespace = '858f2930-d5f9-4bc5-bc4f-214006f8d2f7';
const fixtureTime = '2026-01-01T00:00:00.000Z';
const metrics: Value[] = [];
const evidence: Value[] = [];
const validPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

/** 实际解码 PNG 像素，防止仅验证不透明字符串而接受损坏的图片夹具。 */
async function checkPng(image: string) {
  try {
    const decoded = await sharp(Buffer.from(image, 'base64'), { failOn: 'warning' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(decoded.info.width, 1);
    assert.equal(decoded.info.height, 1);
    assert(decoded.data.length > 0);
    return createHash('sha256').update(Buffer.from(image, 'base64')).digest('hex');
  } catch (cause) {
    throw new Error('PNG 夹具无法解码，附件验收不能继续', { cause });
  }
}

/** 所有实体身份从固定种子派生，保证不同机器生成相同数据。 */
function id(label: string): string {
  return uuidV5(namespace, label);
}

/** 每次请求保留完整业务错误，但不输出认证令牌。 */
async function request(session: Value | null, method: 'GET' | 'POST', route: string, payload?: Value, status = 200) {
  try {
    const response = await app.inject({
      method,
      url: `/api/v1${route}`,
      payload,
      headers: session ? { authorization: `Bearer ${session.access_token}` } : {},
    });
    assert.equal(response.statusCode, status, `${method} ${route}: ${response.body.slice(0, 3000)}`);
    return response.json<Value>();
  } catch (cause) {
    throw new Error(`验收请求失败：${method} ${route}`, { cause });
  }
}

/** 为每个档位创建独立合成账号，登录使用独立安装标识模拟另一设备。 */
async function session(years: number, login = false) {
  try {
    return await request(
      null,
      'POST',
      `/auth/${login ? 'login' : 'register'}`,
      {
        country_code: '+86',
        phone: `1390000${years.toString().padStart(4, '0')}`,
        password: 'synthetic-acceptance-password',
        device: { installation_id: id(`${years}-${login ? 'peer' : 'owner'}`), name: '合成验收设备', platform: 'test' },
      },
      login ? 200 : 201,
    );
  } catch (cause) {
    throw new Error('隔离账号准备失败', { cause });
  }
}

/** 用真实同步写入口发送有界批次，避免请求体上限成为数据规模的替身。 */
async function push(owner: Value, changes: Value[]) {
  try {
    const result = await request(owner, 'POST', '/sync/push', { device_id: owner.device_id, changes });
    for (const outcome of result.outcomes)
      assert(['accepted', 'ignored'].includes(outcome.status), JSON.stringify(outcome));
    return result;
  } catch (cause) {
    throw new Error('同步写入或幂等重放未满足预期', { cause });
  }
}

/** 构造完整同步外壳；父本身份随当前档位绑定。 */
function change(years: number, type: string, index: number, payload: Value, scope: Value = {}) {
  return {
    mutation_id: id(`${years}-${type}-${index}-mutation`),
    entity_type: type,
    entity_id: id(`${years}-${type}-${index}`),
    ledger_id: null,
    day_book_id: null,
    memo_book_id: null,
    action: 'upsert',
    updated_at: fixtureTime,
    payload,
    ...scope,
  };
}

/** 采样三次并保存全部值；不把单次或本机 API 耗时解释成手机体验。 */
async function measure(years: number, label: string, operation: () => Promise<Value>, repeats = 3) {
  const samples = [];
  let value: Value = {};
  try {
    for (let i = 0; i < repeats; i++) {
      const before = performance.now();
      value = await operation();
      samples.push(Number((performance.now() - before).toFixed(2)));
    }
    metrics.push({
      years,
      label,
      samples_ms: samples,
      median_ms: [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)],
    });
    console.log(JSON.stringify(metrics.at(-1)));
    return value;
  } catch (cause) {
    throw new Error(`测量失败：${years} 年 ${label}`, { cause });
  }
}

/** 规范化对象字段，恢复时只排除明确会轮换的绑定身份及全局水位。 */
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => !['sync_id', 'server_cursor'].includes(key))
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

/** 快照内容散列涵盖所有字段、父子关系与内嵌图片，不保存正文到报告。 */
function digest(value: Value): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

/** 分页遍历增量事件并核对事件 ID 唯一性。 */
async function pull(owner: Value, since = '0') {
  try {
    const ids = new Set<string>();
    const entities: string[] = [];
    let cursor = since;
    let pages = 0;
    while (true) {
      const page = await request(owner, 'GET', `/sync/pull?since=${cursor}&limit=1000`);
      pages++;
      for (const row of page.changes) {
        assert(!ids.has(row.change_id));
        ids.add(row.change_id);
        entities.push(row.entity_id);
      }
      cursor = page.server_cursor;
      if (!page.has_more) return { count: ids.size, pages, cursor, entities };
      assert(pages < 1000, '分页未收敛');
    }
  } catch (cause) {
    throw new Error('同步分页完整性核对失败', { cause });
  }
}

/** 为 1、5、10 年档位生成每日 5 笔账、每月 10 条备忘、每周 3 次训练。 */
async function seed() {
  try {
    const states = [];
    for (const years of [1, 5, 10]) {
      const owner = await session(years);
      const ledgerId = id(`${years}-ledger-0`);
      const bookId = id(`${years}-memo_book-0`);
      const spaceId = id(`${years}-fitness_space-0`);
      const parentChanges = [
        change(
          years,
          'ledger',
          0,
          { name: `${years} 年生活账`, currency: 'CNY', month_start_day: 1, aa_enabled: false },
          { ledger_id: ledgerId },
        ),
        change(
          years,
          'memo_book',
          0,
          { name: `${years} 年备忘`, type: 'normal', created_at: fixtureTime, updated_at: fixtureTime },
          { memo_book_id: bookId },
        ),
        change(
          years,
          'fitness_space',
          0,
          { name: `${years} 年健身`, created_at: fixtureTime, updated_at: fixtureTime },
          { fitness_space_id: spaceId },
        ),
      ];
      const parents = (await push(owner, parentChanges)).outcomes;
      const ledgerSync = parents[0].sync_id;
      const memoSync = parents[1].sync_id;
      const fitnessSync = parents[2].sync_id;
      const txs = years * 1825;
      const memos = years * 120;
      const workouts = years * 156;
      const mutations: Value[] = [];
      for (let i = 0; i < txs; i++)
        mutations.push(
          change(
            years,
            'transaction',
            i,
            {
              tx_type: 'expense',
              amount: `${(i % 100) + 1}.25`,
              native_amount: `${(i % 100) + 1}.25`,
              currency_code: 'CNY',
              happened_at: new Date(Date.UTC(2026 - years, 0, 1) + Math.floor(i / 5) * 86400000).toISOString(),
              note: `合成日常账 ${i} 中文 😀`,
              category_id: null,
              recurring_id: null,
              aa_mode: null,
              splits: null,
              last_edited_at: null,
            },
            { ledger_id: ledgerId, sync_id: ledgerSync },
          ),
        );
      for (let i = 0; i < memos; i++)
        mutations.push(
          change(
            years,
            'memo_entry',
            i,
            {
              book_type: 'normal',
              title: `备忘 ${i}`,
              body_format: 'delta_v1',
              body: {
                ops: [
                  {
                    insert: i % 10 === 0 ? '多年回看 中文😀é\u0000\n'.repeat(600) : `短备忘 ${i}\n`,
                    attributes: { bold: true },
                  },
                  { insert: '\n' },
                ],
              },
              order_key: null,
              created_at: fixtureTime,
              updated_at: fixtureTime,
            },
            { memo_book_id: bookId, sync_id: memoSync },
          ),
        );
      const customImage = validPng;
      await checkPng(customImage);
      mutations.push(
        change(
          years,
          'fitness_preferences',
          0,
          {
            ...fitnessPreferences(),
            custom_exercises: [
              {
                id: `custom:${id(`${years}-exercise`)}`,
                name: '合成划船',
                body_part: 'back',
                equipment: 'dumbbell',
                icon: 'dumbbell',
                image: customImage,
                deleted: false,
              },
            ],
          },
          { entity_id: spaceId, fitness_space_id: spaceId, sync_id: fitnessSync },
        ),
      );
      for (let i = 0; i < workouts; i++) {
        const date = new Date(Date.UTC(2026 - years, 0, 1) + Math.floor((i * 7) / 3) * 86400000).toISOString();
        mutations.push(
          change(
            years,
            'fitness_workout',
            i,
            {
              ...fitnessWorkout(),
              name: `训练 ${i}`,
              scheduled_date: date.slice(0, 10),
              status: 'completed',
              run_segments: [{ started_at: date, ended_at: new Date(Date.parse(date) + 3600000).toISOString() }],
              exercises: Array.from({ length: 5 }, (_, j) => ({
                id: id(`${years}-${i}-${j}-exercise`),
                exercise_id: `custom:${id(`${years}-exercise`)}`,
                rest_seconds: 90,
                warmup_rest_seconds: null,
                sets: Array.from({ length: 3 }, (_, k) => ({
                  id: id(`${years}-${i}-${j}-${k}-set`),
                  kind: 'working',
                  weight: '62.5000000001',
                  weight_left: null,
                  weight_right: null,
                  reps: 8,
                  completed: true,
                })),
              })),
            },
            { fitness_space_id: spaceId, sync_id: fitnessSync },
          ),
        );
      }
      await measure(
        years,
        'initial_upload_all_entities',
        async () => {
          for (let i = 0; i < mutations.length; i += 50) await push(owner, mutations.slice(i, i + 50));
          return {};
        },
        1,
      );
      const peer = await session(years, true);
      const ledgerRoute = `/sync/full?ledger_id=${ledgerId}`;
      const memoRoute = `/sync/memo-books/full?memo_book_id=${bookId}`;
      const fitnessRoute = `/sync/fitness-spaces/full?fitness_space_id=${spaceId}`;
      const ledger = await measure(years, 'ledger_full', () => request(peer, 'GET', ledgerRoute));
      const memo = await measure(years, 'memo_full', () => request(peer, 'GET', memoRoute));
      const fitness = await measure(years, 'fitness_full', () => request(peer, 'GET', fitnessRoute));
      assert.equal(ledger.transactions.length, txs);
      assert.equal(memo.memo_entries.length, memos);
      assert.equal(fitness.fitness_workouts.length, workouts);
      const transactionLookup = new Map(ledger.transactions.map((row: Value) => [row.id, row]));
      for (const mutation of mutations.filter((row) => row.entity_type === 'transaction')) {
        const actual: any = transactionLookup.get(mutation.entity_id);
        for (const key of [
          'tx_type',
          'amount',
          'native_amount',
          'currency_code',
          'happened_at',
          'note',
          'category_id',
          'recurring_id',
        ])
          assert.deepEqual(actual[key], mutation.payload[key]);
      }
      // 每条内容逐字段核对，图片和训练组的引用关系随完整载荷一同验证。
      for (const [type, rows] of [
        ['memo_entry', memo.memo_entries],
        ['fitness_workout', fitness.fitness_workouts],
      ] as const) {
        const lookup = new Map(rows.map((row: Value) => [row.id, row]));
        for (const mutation of mutations.filter((row) => row.entity_type === type)) {
          const actual: any = lookup.get(mutation.entity_id);
          for (const [key, value] of Object.entries(mutation.payload)) assert.deepEqual(actual[key], value);
        }
      }
      assert.equal(fitness.fitness_preferences[0].custom_exercises[0].image, customImage);
      const initialPull = await measure(years, 'initial_pull_pages', () => pull(peer));
      for (const mutation of mutations) assert(initialPull.entities.includes(mutation.entity_id));
      await measure(years, 'empty_incremental_pull', () => pull(peer, initialPull.cursor));
      await measure(years, 'transaction_first_page', () =>
        request(peer, 'GET', `/ledgers/${ledgerId}/transactions?limit=50`),
      );
      const edit: Value = {
        ...mutations.find((row) => row.entity_type === 'memo_entry')!,
        mutation_id: id(`${years}-offline-edit`),
        base_revision: 1,
        payload: { ...mutations.find((row) => row.entity_type === 'memo_entry')!.payload, title: '离线新增修改后回传' },
      };
      await measure(years, 'single_incremental_write', () => push(owner, [edit]), 1);
      const replay = await push(owner, [edit]);
      assert.equal(replay.outcomes[0].status, 'ignored');
      const delta = await measure(years, 'single_incremental_pull', () => pull(peer, initialPull.cursor));
      assert.deepEqual(delta.entities, [edit.entity_id]);
      const latestMemo = await request(peer, 'GET', memoRoute);
      assert.equal(latestMemo.memo_entries.find((row: Value) => row.id === edit.entity_id).title, edit.payload.title);
      const stale = await request(peer, 'POST', '/sync/push', {
        device_id: peer.device_id,
        changes: [{ ...edit, mutation_id: id(`${years}-stale`), payload: { ...edit.payload, title: '旧客户端覆盖' } }],
      });
      assert.equal(stale.outcomes[0].status, 'conflict');
      const expected = {
        txs,
        memos,
        workouts,
        exerciseRecords: workouts * 5,
        setRecords: workouts * 15,
        ledgerHash: digest(await request(peer, 'GET', ledgerRoute)),
        memoHash: digest(await request(peer, 'GET', memoRoute)),
        fitnessHash: digest(await request(peer, 'GET', fitnessRoute)),
      };
      states.push({
        years,
        owner,
        ledgerId,
        bookId,
        spaceId,
        ledgerSync,
        memoSync,
        fitnessSync,
        ledgerRoute,
        memoRoute,
        fitnessRoute,
        expected,
      });
      evidence.push({ years, ...expected, correct: true, lostResponseReplay: 'ignored', staleEdit: 'conflict' });
      writeFileSync(
        path.join(output, 'scale-results.json'),
        JSON.stringify(
          {
            environment: {
              cpu: os.cpus()[0]?.model,
              logicalCpus: os.cpus().length,
              totalMemoryGiB: os.totalmem() / 2 ** 30,
            },
            metrics,
            evidence,
          },
          null,
          2,
        ),
      );
    }
    writeFileSync(path.join(output, 'restore-state.json'), JSON.stringify(states));
  } catch (cause) {
    throw new Error('多年数据同步验收失败', { cause });
  }
}

/** 真实还原后核对内容散列、会话失效、旧绑定拒绝与重新登录后的增量往返。 */
async function verify() {
  try {
    const states: Value[] = JSON.parse(readFileSync(path.join(output, 'restore-state.json'), 'utf8'));
    for (const state of states) {
      await request(state.owner, 'GET', state.ledgerRoute, undefined, 401);
      const peer = await session(state.years, true);
      for (const [route, hash, previous] of [
        [state.ledgerRoute, state.expected.ledgerHash, state.ledgerSync],
        [state.memoRoute, state.expected.memoHash, state.memoSync],
        [state.fitnessRoute, state.expected.fitnessHash, state.fitnessSync],
      ]) {
        await request(peer, 'GET', `${route}&sync_id=${previous}`, undefined, 412);
        assert.equal(digest(await request(peer, 'GET', route)), hash, `恢复后内容散列 ${route}`);
      }
      const snapshot = await request(peer, 'GET', state.memoRoute);
      const first = snapshot.memo_entries[0];
      const edit = change(
        state.years,
        'memo_entry',
        999999,
        {
          book_type: first.book_type,
          title: '还原后离线编辑回传',
          body_format: first.body_format,
          body: first.body,
          order_key: first.order_key,
          created_at: first.created_at,
          updated_at: first.updated_at,
        },
        {
          entity_id: first.id,
          memo_book_id: state.bookId,
          sync_id: snapshot.memo_book.sync_id,
          base_revision: first.revision,
        },
      );
      await push(peer, [edit]);
      assert.equal((await push(peer, [edit])).outcomes[0].status, 'ignored');
      const delivered = await pull(peer, snapshot.server_cursor);
      assert.deepEqual(delivered.entities, [first.id]);
      const freshPeer = await session(state.years, true);
      const after = await request(freshPeer, 'GET', state.memoRoute);
      assert.equal(after.memo_entries.find((row: Value) => row.id === first.id).title, edit.payload.title);
      assert.equal(after.memo_entries.length, state.expected.memos);
      evidence.push({
        years: state.years,
        restoredContentHashes: 'all_match',
        oldSession: 401,
        oldBindings: 412,
        reloginAndEdit: 'accepted',
        lostResponseReplay: 'ignored',
        incrementalEvents: 1,
        duplicates: 0,
      });
    }
    writeFileSync(path.join(output, 'recovery-results.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
  } catch (cause) {
    throw new Error('真实数据库还原后的重连核对失败', { cause });
  }
}

/** 独立小规模图片链路复用真实同步与数据库恢复，不重复多年数据上传。 */
async function attachment(recover: boolean) {
  try {
    const stateFile = path.join(output, 'attachment-state.json');
    let state: Value;
    if (recover) {
      state = JSON.parse(readFileSync(stateFile, 'utf8'));
      await request(state.owner, 'GET', state.route, undefined, 401);
    } else {
      const owner = await session(99);
      const spaceId = id('99-fitness_space-0');
      const created = await push(owner, [
        change(
          99,
          'fitness_space',
          0,
          {
            name: '有效图片恢复验收',
            created_at: fixtureTime,
            updated_at: fixtureTime,
          },
          { fitness_space_id: spaceId },
        ),
      ]);
      const syncId = created.outcomes[0].sync_id;
      const imageHash = await checkPng(validPng);
      await push(owner, [
        change(
          99,
          'fitness_preferences',
          0,
          {
            ...fitnessPreferences(),
            custom_exercises: [
              {
                id: `custom:${id('attachment-custom')}`,
                name: '有效图片',
                body_part: 'back',
                equipment: 'dumbbell',
                icon: 'dumbbell',
                image: validPng,
                deleted: false,
              },
            ],
          },
          { entity_id: spaceId, fitness_space_id: spaceId, sync_id: syncId },
        ),
      ]);
      state = { owner, route: `/sync/fitness-spaces/full?fitness_space_id=${spaceId}`, syncId, imageHash };
      writeFileSync(stateFile, JSON.stringify(state));
    }
    const peer = await session(99, true);
    if (recover) await request(peer, 'GET', `${state.route}&sync_id=${state.syncId}`, undefined, 412);
    const snapshot = await request(peer, 'GET', state.route);
    const image = snapshot.fitness_preferences[0].custom_exercises[0].image;
    assert.equal(image, validPng);
    assert.equal(await checkPng(image), state.imageHash);
    const result = {
      restored: recover,
      syncedImageBytes: Buffer.from(image, 'base64').length,
      sha256: state.imageHash,
      decodedDimensions: [1, 1],
      validImage: true,
      scope: '健身自定义动作内嵌PNG；真实API与PostgreSQL；恢复阶段来自pg_dump/pg_restore。',
    };
    writeFileSync(
      path.join(output, recover ? 'attachment-recovery-results.json' : 'attachment-results.json'),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } catch (cause) {
    throw new Error('有效图片同步恢复补验失败', { cause });
  }
}

try {
  await app.ready();
  metrics.push({ label: 'in_process_app_ready', samples_ms: [Number((performance.now() - start).toFixed(2))] });
  if (process.argv[2] === 'seed') await seed();
  else if (process.argv[2] === 'verify') await verify();
  else if (process.argv[2] === 'attachment-seed') await attachment(false);
  else if (process.argv[2] === 'attachment-verify') await attachment(true);
  else throw new Error('请指定 seed、verify、attachment-seed 或 attachment-verify');
} catch (error) {
  console.error('隔离合成数据验收失败，请查看错误链。', inspect(error, { depth: 12 }));
  process.exitCode = 1;
} finally {
  try {
    await app.close();
  } catch (error) {
    console.error('关闭验收应用失败', error);
    process.exitCode = 1;
  }
}
