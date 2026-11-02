import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

/** 执行真实发布预检片段，通过隔离依赖记录查询与连接释放，避免触及运行中的数据库。 */
async function inspectCurrentSync(rows) {
  try {
    const source = readFileSync(new URL('../deploy/release-api.py', import.meta.url), 'utf8');
    const script = source.match(/CURRENT_SYNC_STATUS = """([\s\S]*?)"""/)?.[1];
    if (!script) throw new Error('发布脚本当前同步预检片段缺失');
    const output = [];
    const errors = [];
    const process = { exitCode: 0 };
    let disconnected = false;
    class Database {
      /** 按当前预检读取顺序提供结构和持久状态，查询结束后不会回落到其他来源。 */
      async $queryRawUnsafe() {
        try {
          if (!rows.length) throw new Error('预检读取次数超出夹具');
          return rows.shift();
        } catch (cause) {
          throw new Error('发布预检数据库夹具读取失败', { cause });
        }
      }
      /** 标记连接释放，让失败分支也必须完成资源清理。 */
      async $disconnect() {
        try {
          disconnected = true;
        } catch (cause) {
          throw new Error('预检夹具连接释放失败', { cause });
        }
      }
    }
    await runInNewContext(script, {
      require: () => ({ PrismaClient: Database }),
      process,
      Date,
      console: { log: (value) => output.push(JSON.parse(value)), error: (...value) => errors.push(value) },
    });
    assert.equal(disconnected, true);
    return { code: process.exitCode, output, errors };
  } catch (cause) {
    throw new Error('当前数据库发布预检验收失败', { cause });
  }
}

test('发布只接受完整当前同步状态，保留大整数切点与持久水位', async () => {
  const result = await inspectCurrentSync([
    [{ installed: 3 }],
    [{ cursor: '9223372036854775806', completed: new Date(), floor: '9223372036854775807' }],
  ]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.output, [
    { completed: true, original_cursor: '9223372036854775806', cursor_floor: '9223372036854775807' },
  ]);
  assert.equal(result.errors.length, 0);
});

for (const state of [
  { columns: 2 },
  { cursor: null },
  { completed: null },
  { floor: '-1' },
  { completed: new Date('invalid') },
]) {
  test(`发布拒绝缺失或不完整的当前同步事实：${Object.keys(state)[0]}`, async () => {
    const result = await inspectCurrentSync([
      [{ installed: state.columns ?? 3 }],
      [{ cursor: '10', completed: new Date(), floor: '11', ...state }],
    ]);
    assert.equal(result.code, 1);
    assert.deepEqual(result.output, []);
    assert.equal(result.errors.length, 1);
  });
}
