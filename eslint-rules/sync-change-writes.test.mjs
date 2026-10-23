import assert from 'node:assert/strict';
import test from 'node:test';
import { ESLint } from 'eslint';

const eslint = new ESLint();

/** 交易旁路创建会遗漏分摊或事件，生产代码和运维脚本统一遵守领域写入边界。 */
test('交易创建门禁覆盖调用、可选链与提取委托，且保留事件门禁', async () => {
  try {
    for (const filePath of ['apps/api/src/modules/sync/bypass.ts', 'scripts/bypass.mjs']) {
      for (const method of ['create', 'createMany', 'createManyAndReturn', 'upsert']) {
        for (const expression of [
          `tx.transaction.${method}({})`,
          `tx['transaction']['${method}']({})`,
          `tx?.transaction?.${method}({})`,
          `tx.transaction.${method}`,
        ]) {
          const [result] = await eslint.lintText(`${expression};\n`, { filePath });
          assert.equal(
            result.messages.filter((message) => message.ruleId === 'sesame-notes/transaction-creation').length,
            1,
          );
        }
      }
    }
    const [eventResult] = await eslint.lintText('tx.syncChange.create({});\n', {
      filePath: 'apps/api/src/modules/accounting/transaction-creation.ts',
    });
    assert.equal(eventResult.messages.filter((message) => message.ruleId === 'no-restricted-syntax').length, 1);
  } catch (cause) {
    console.error('交易创建边界门禁验证失败', cause);
    throw cause;
  }
});

/** 单一创建操作、测试夹具与普通读取不会被创建门禁误拦截。 */
test('交易创建门禁保留领域实现、测试夹具及查询', async () => {
  try {
    for (const [filePath, expression] of [
      ['apps/api/src/modules/accounting/transaction-creation.ts', 'tx.transaction.create({})'],
      ['apps/api/test/transaction.e2e.test.ts', 'tx.transaction.createMany({})'],
      ['apps/api/src/modules/accounting/transaction-creation.test.ts', 'tx.transaction.create({})'],
      ['apps/api/src/modules/sync/read.ts', 'tx.transaction.findMany({})'],
    ]) {
      const [result] = await eslint.lintText(`${expression};\n`, { filePath });
      assert.equal(
        result.messages.filter((message) => message.ruleId === 'sesame-notes/transaction-creation').length,
        0,
      );
    }
  } catch (cause) {
    console.error('交易创建门禁有效入口验证失败', cause);
    throw cause;
  }
});

/** 删除账号只能通过受控用例，读取、测试夹具与该用例本身可访问数据库。 */
test('账号删除门禁拒绝业务旁路且不覆盖同步事件门禁', async () => {
  try {
    for (const expression of [
      'tx.user.delete({})',
      "tx['user']['deleteMany']({})",
      'tx?.user?.delete({})',
      'tx.user.delete',
    ]) {
      const [result] = await eslint.lintText(`${expression};\n`, { filePath: 'apps/api/src/modules/admin/bypass.ts' });
      assert.equal(result.messages.filter((message) => message.ruleId === 'sesame-notes/account-deletion').length, 1);
    }
    for (const filePath of [
      'apps/api/src/modules/accounts/account-deletion.ts',
      'apps/api/test/account-deletion.e2e.test.ts',
    ]) {
      const [result] = await eslint.lintText('tx.user.delete({});\n', { filePath });
      assert.equal(result.messages.filter((message) => message.ruleId === 'sesame-notes/account-deletion').length, 0);
    }
  } catch (cause) {
    console.error('账号删除旁路门禁失败', cause);
    throw cause;
  }
});

/** 同步事件的写入只允许经 sync-events 公共入口进入受保护的事务。 */
test('syncChange：生产和脚本拒绝直接调用所有写方法', async () => {
  const methods = [
    'create',
    'createMany',
    'createManyAndReturn',
    'update',
    'updateMany',
    'updateManyAndReturn',
    'upsert',
    'delete',
    'deleteMany',
  ];
  // 两种解析器分别覆盖全部写方法与语法，目录匹配单独验证。
  const paths = ['apps/api/src/modules/sync/direct-write.ts', 'scripts/direct-write.mjs'];

  for (const filePath of paths) {
    for (const method of methods) {
      for (const expression of [
        `tx.syncChange.${method}({})`,
        `tx['syncChange']['${method}']({})`,
        `tx.syncChange['${method}']({})`,
        `tx['syncChange'].${method}({})`,
        `tx?.syncChange?.${method}({})`,
        `tx.syncChange.${method}`,
      ]) {
        const [result] = await eslint.lintText(`${expression};\n`, { filePath });
        const errors = result.messages.filter((message) => message.ruleId === 'no-restricted-syntax');
        assert.equal(errors.length, 1, `${filePath}: ${expression} 应拒绝直接写入同步事件`);
        assert.equal(errors[0].severity, 2);
      }
    }
  }

  for (const filePath of ['apps/api/scripts/direct-write.ts', 'apps/api/prisma/direct-write.ts']) {
    const [result] = await eslint.lintText('tx.syncChange.create({});\n', { filePath });
    const errors = result.messages.filter((message) => message.ruleId === 'no-restricted-syntax');
    assert.equal(errors.length, 1, `${filePath}: 脚本和数据库目录必须启用写入限制`);
    assert.equal(errors[0].severity, 2);
  }
});

/** 读取同步事件、唯一写入口和测试数据准备不受写入门禁限制。 */
test('syncChange：保留读取、统一写入口和测试数据准备', async () => {
  const cases = [
    ['apps/api/src/modules/sync/sync-query.ts', 'tx.syncChange.findMany({});'],
    ['apps/api/src/modules/sync/sync-query.ts', 'tx.syncChange.count({});'],
    ['apps/api/src/modules/sync-events/event-store.ts', 'tx.syncChange.create({});'],
    ['apps/api/test/sync.test.ts', 'tx.syncChange.create({});'],
    ['apps/api/src/modules/sync/sync.test.ts', 'tx.syncChange.create({});'],
    ['scripts/direct-write.test.mjs', 'tx.syncChange.create({});'],
  ];

  for (const [filePath, code] of cases) {
    const [result] = await eslint.lintText(code, { filePath });
    assert.deepEqual(
      result.messages.filter((message) => message.ruleId === 'no-restricted-syntax'),
      [],
      `${filePath}: ${code} 应允许`,
    );
  }
});
