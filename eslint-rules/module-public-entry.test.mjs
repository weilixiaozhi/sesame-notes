import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint, RuleTester } from 'eslint';

import rule from './module-public-entry.mjs';

/** 测试账号初始化只允许 CLI 与测试引用，生产装配和模块出口均不能转发。 */
test('module-public-entry：隔离测试初始化 CLI 能力', () => {
  try {
    const tester = new RuleTester({ languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } });
    tester.run('module-public-entry', rule, {
      valid: [
        {
          filename: resolve('apps/api/src/admin-test-bootstrap.ts'),
          code: "import './admin-test-initialization.js';",
        },
        {
          filename: resolve('apps/api/src/admin-test-initialization.test.ts'),
          code: "import './admin-test-initialization.js';",
        },
      ],
      invalid: [
        {
          filename: resolve('apps/api/src/app.ts'),
          code: "import './admin-test-initialization.js';",
          errors: [{ messageId: 'maintenanceEntry' }],
        },
        {
          filename: resolve('apps/api/src/modules/admin/index.ts'),
          code: "export * from '../../admin-test-initialization.js';",
          errors: [{ messageId: 'maintenanceEntry' }],
        },
        {
          filename: resolve('apps/api/src/modules/admin/admin-auth.ts'),
          code: "void import('../../admin-test-initialization.js');",
          errors: [{ messageId: 'maintenanceEntry' }],
        },
      ],
    });
  } catch (error) {
    console.error('测试初始化 CLI 边界回归失败', error);
    throw error;
  }
});

/** 测试出口保持可测性，但不能被生产代码或公共出口带入运行依赖图。 */
test('module-public-entry：测试出口只允许测试文件消费', () => {
  try {
    const tester = new RuleTester({ languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } });
    tester.run('module-public-entry', rule, {
      valid: [
        { filename: resolve('apps/api/test/money.test.ts'), code: "import '../src/modules/accounting/testing.js';" },
      ],
      invalid: [
        {
          filename: resolve('apps/api/src/modules/accounting/index.ts'),
          code: "export * from './testing.js';",
          errors: [{ messageId: 'testOnlyEntry' }],
        },
        {
          filename: resolve('apps/api/src/modules/imports/import-routes.ts'),
          code: "import '../accounting/testing.js';",
          errors: [{ messageId: 'testOnlyEntry' }],
        },
        {
          filename: resolve('apps/api/scripts/example.ts'),
          code: "import '../src/modules/accounting/testing.js';",
          errors: [{ messageId: 'testOnlyEntry' }],
        },
      ],
    });
  } catch (error) {
    console.error('测试专用出口边界验收失败', error);
    throw error;
  }
});

/** 公共出口不豁免分层方向；基础设施保持独立，业务不引用应用组装。 */
test('module-public-entry：阻止共享层和事件基础设施反向依赖业务', () => {
  const tester = new RuleTester({ languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } });
  tester.run('module-public-entry', rule, {
    valid: [
      {
        filename: resolve('apps/api/src/modules/sync-events/event-store.ts'),
        code: "import '../../shared/sync-transaction.js';",
      },
      {
        filename: resolve('apps/api/src/modules/accounting/transaction-routes.ts'),
        code: "import '../sync-events/index.js';",
      },
    ],
    invalid: [
      {
        filename: resolve('apps/api/src/shared/example.ts'),
        code: "import '../modules/accounting/index.js';",
        errors: [{ messageId: 'reverseDependency' }],
      },
      {
        filename: resolve('apps/api/src/modules/sync-events/example.ts'),
        code: "export { value } from '../accounting/index.js';",
        errors: [{ messageId: 'reverseDependency' }],
      },
      {
        filename: resolve('apps/api/src/modules/auth/example.ts'),
        code: "import '../../app.js';",
        errors: [{ messageId: 'reverseDependency' }],
      },
      ...['admin-recover', 'admin-test-bootstrap', 'server-recover'].map((entry) => ({
        filename: resolve('apps/api/src/modules/auth/example.ts'),
        code: `import '../../${entry}.js';`,
        errors: [{ messageId: 'reverseDependency' }],
      })),
    ],
  });
});

/** 实际项目配置必须将全部手写入口的跨模块深导入作为错误，并放行公共出口。 */
test('module-public-entry：项目配置覆盖测试、脚本、客户端与根配置', async (t) => {
  const eslint = new ESLint();
  const paths = [
    'apps/api/src/app.ts',
    'apps/api/src/admin-bootstrap.ts',
    'apps/api/test/boundary.test.ts',
    'apps/api/scripts/generate-openapi.ts',
    'apps/api/vitest.config.ts',
    'packages/api-client/src/client.ts',
    'packages/api-client/test/boundary.test.ts',
    'packages/api-client/scripts/generate.mjs',
    'scripts/boundary.mjs',
    'eslint-rules/boundary.test.mjs',
    'eslint.config.js',
  ];

  for (const filePath of paths) {
    await t.test(filePath, async () => {
      try {
        const modulePath = relative(dirname(filePath), 'apps/api/src/modules/accounting').replaceAll('\\', '/');
        const source = modulePath.startsWith('.') ? modulePath : `./${modulePath}`;
        const [invalid] = await eslint.lintText(`import '${source}/money.js';\n`, { filePath });
        const errors = invalid.messages.filter((message) => message.ruleId === 'sesame-notes/module-public-entry');
        assert.equal(errors.length, 1, `${filePath} 必须拒绝模块深导入`);
        assert.equal(errors[0].severity, 2, `${filePath} 的模块深导入必须是 error`);

        const [valid] = await eslint.lintText(`import '${source}/index.js';\n`, { filePath });
        assert.deepEqual(
          valid.messages.filter((message) => message.ruleId === 'sesame-notes/module-public-entry'),
          [],
          `${filePath} 必须允许公共出口`,
        );
      } catch (error) {
        console.error(`模块边界配置验收失败：${filePath}`, error);
        throw error;
      }
    });
  }
});

/** 接口契约向页面提供数据定义，类型导入、转发和动态导入也不能反转依赖方向。 */
test('module-public-entry：Admin 接口层不能依赖页面或 UI，实际配置保留测试验收边界', async (t) => {
  const cases = [
    {
      filename: 'apps/admin/src/api/response-validation.ts',
      code: "import '../features/analytics/response-schema';",
      rejected: true,
    },
    {
      filename: 'apps/admin/src/api/example.ts',
      code: "import type { AnalysisSelection } from '../features/analytics/model';",
      rejected: true,
    },
    { filename: 'apps/admin/src/api/example.ts', code: "export { Button } from '../components/ui';", rejected: true },
    { filename: 'apps/admin/src/api/example.ts', code: "void import('../app/routes');", rejected: true },
    { filename: 'apps/admin/src/api/response-validation.ts', code: "import './analytics-contracts';", rejected: false },
    {
      filename: 'apps/admin/src/features/analytics/events.tsx',
      code: "import '../../api/analytics-contracts';",
      rejected: false,
    },
    { filename: 'apps/admin/src/api/boundaries.test.ts', code: "import '../app/routes';", rejected: false },
  ];
  const eslint = new ESLint();
  for (const [index, entry] of cases.entries()) {
    await t.test(`${index + 1}. ${entry.filename}`, async () => {
      try {
        const [result] = await eslint.lintText(`${entry.code}\n`, { filePath: entry.filename });
        assert.equal(
          result.messages.some((message) => message.fatal),
          false,
          '门禁夹具必须能被项目实际解析器解析',
        );
        const errors = result.messages.filter((message) => message.ruleId === 'sesame-notes/module-public-entry');
        assert.equal(errors.length, entry.rejected ? 1 : 0);
        if (entry.rejected) {
          assert.equal(errors[0].messageId, 'reverseDependency');
          assert.equal(errors[0].severity, 2);
        }
      } catch (error) {
        console.error(`Admin 接口分层门禁验收失败：${entry.filename}`, error);
        throw error;
      }
    });
  }
});

/** 根 lint 命令的实际参数必须拒绝仅含 warning 的输入，保持 CI 零警告门禁。 */
test('lint：没有 error、只有 warning 时命令失败', () => {
  try {
    const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const [command, ...args] = scripts.lint.split(/\s+/);
    assert.equal(command, 'eslint');
    const cli = fileURLToPath(new URL('bin/eslint.js', import.meta.resolve('eslint/package.json')));
    const result = spawnSync(
      process.execPath,
      [cli, ...args, '--stdin', '--stdin-filename', 'scripts/lint-warning.mjs', '--format', 'json'],
      {
        cwd: resolve(import.meta.dirname, '..'),
        input: '/* eslint no-console: warn */\nconsole.log("warning");\n',
        encoding: 'utf8',
      },
    );
    if (result.error) throw result.error;
    const [lint] = JSON.parse(result.stdout);
    assert.equal(lint.errorCount, 0, result.stdout);
    assert.equal(lint.warningCount, 1, result.stdout);
    assert.equal(result.status, 1, `仅有 warning 时必须失败：${result.stderr}`);
  } catch (error) {
    console.error('零警告 lint 门禁验收失败', error);
    throw error;
  }
});

/** 需求期望：src/modules 下的跨模块相对导入只允许指向模块公共出口 index.js， 禁止 deep import 模块内部文件；模块内部同目录导入、shared 基础设施层不受限。 */
test('module-public-entry：跨模块导入必须走公共出口 index.js', () => {
  const appFile = resolve('apps/api/src/app.ts');
  const authFile = resolve('apps/api/src/modules/auth/auth.ts');
  const accountingFile = resolve('apps/api/src/modules/accounting/ledger-routes.ts');
  const sharingIndex = resolve('apps/api/src/modules/sharing/index.ts');
  const ruleTester = new RuleTester({
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  });

  ruleTester.run('module-public-entry', rule, {
    valid: [
      // 公共出口导入
      { filename: authFile, code: `import { getLedgerAccess } from '../accounting/index.js';` },
      { filename: accountingFile, code: `import { authenticate } from '../auth/index.js';` },
      // app.ts 组装层走出口
      { filename: appFile, code: `import { registerAccountingRoutes } from './modules/accounting/index.js';` },
      // 共享基础设施层（不受出口约束）
      { filename: authFile, code: `import { ApiError } from '../../shared/errors.js';` },
      // 模块对 src 根配置文件的引用（非跨模块导入，不得误伤）
      { filename: authFile, code: `import { ApiConfig } from '../../config.js';` },
      // 模块内部同目录导入
      { filename: accountingFile, code: `import { createChange } from './change-log.js';` },
      // 公共出口可转发另一个模块的公共出口
      { filename: sharingIndex, code: `export { registeredMemberId } from '../accounting/index.js';` },
    ],
    invalid: [
      // 跨模块 deep import 一律报错
      {
        filename: authFile,
        code: `import { getLedgerAccess } from '../accounting/ledger-routes.js';`,
        errors: [{ messageId: 'deepImport' }],
      },
      {
        filename: authFile,
        code: `import { validateAaFields } from '../accounting/money.js';`,
        errors: [{ messageId: 'deepImport' }],
      },
      {
        filename: appFile,
        code: `import { registerAdminRoutes } from './modules/admin/admin-routes.js';`,
        errors: [{ messageId: 'deepImport' }],
      },
      {
        filename: accountingFile,
        code: `import { authenticate } from '../auth/auth.js';`,
        errors: [{ messageId: 'deepImport' }],
      },
      {
        filename: resolve('apps/api/src/modules/auth/nested/handler.ts'),
        code: `import { validateAaFields } from '../../accounting/money.js';`,
        errors: [{ messageId: 'deepImport' }],
      },
      {
        filename: authFile,
        code: `export { validateAaFields } from '../accounting/money.js';`,
        errors: [{ messageId: 'deepImport' }],
      },
      {
        filename: authFile,
        code: `export * from '../accounting/money.js';`,
        errors: [{ messageId: 'deepImport' }],
      },
    ],
  });
});
