import antfu from '@antfu/eslint-config';

import modulePublicEntry from './eslint-rules/module-public-entry.mjs';
import accountDeletion from './eslint-rules/account-deletion.mjs';
import transactionCreation from './eslint-rules/transaction-creation.mjs';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * 项目统一 ESLint Flat Config。
 *
 * 设计取舍：
 * - stylistic 与 perfectionist 排序规则关闭；Prettier 独立负责格式化，导入和字段保持源码顺序。
 * - node/prefer-global 关闭：Node 24 ESM 下 process/Buffer 全局可用，显式 import 属纯风格。
 * - regexp/no-super-linear-backtracking 关闭；正则复杂度和输入边界需要结合调用处审查。
 * - antfu/no-top-level-await 关闭：server.ts 是 ESM 入口脚本，顶层 await 是启动失败即退出的设计。
 * - test/prefer-lowercase-title 关闭：测试标题使用中文，无大小写概念。
 * - yaml/plain-scalar 关闭：compose 文件的 flow 集合写法是 Docker 标准风格。
 * - 保留类型感知规则、未使用变量、导入解析等有行为价值的检查。
 * - openapi.json 是生成契约，不参与 lint。
 */
export default antfu(
  {
    typescript: true,
    stylistic: false,
    vitest: true,
    ignores: ['packages/api-contract/openapi.json'],
  },
  {
    files: ['apps/{web,admin}/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    rules: {
      'perfectionist/sort-imports': 'off',
      'perfectionist/sort-named-imports': 'off',
      'perfectionist/sort-named-exports': 'off',
      'perfectionist/sort-keys': 'off',
      'jsonc/sort-keys': 'off',
      'node/prefer-global/process': 'off',
      'node/prefer-global/buffer': 'off',
      'unicorn/number-literal-case': 'off',
      'ts/consistent-type-definitions': 'off',
      'import/consistent-type-specifier-style': 'off',
      'regexp/no-super-linear-backtracking': 'off',
      'antfu/no-top-level-await': 'off',
      'test/prefer-lowercase-title': 'off',
      'yaml/plain-scalar': 'off',
    },
  },
  {
    // CLI 脚本（seed 等）通过 stdout 输出进度，允许 console.log；
    // scripts/*.mjs 与 eslint-rules/*.test.mjs 使用 Node 内置 node:test（无 vitest 依赖）
    files: ['apps/api/scripts/**/*.ts', 'scripts/**/*.mjs', 'eslint-rules/**/*.mjs'],
    rules: { 'no-console': 'off', 'test/no-import-node-test': 'off' },
  },
  {
    // 全部手写源码、测试、脚本及配置的跨模块导入必须走公共出口 index.js。
    files: [
      '{apps,packages,scripts,eslint-rules}/**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}',
      '*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}',
    ],
    ignores: ['**/generated/**'],
    plugins: {
      'sesame-notes': {
        rules: {
          'module-public-entry': modulePublicEntry,
          'account-deletion': accountDeletion,
          'transaction-creation': transactionCreation,
        },
      },
    },
    rules: { 'sesame-notes/module-public-entry': ['error'] },
  },
  {
    // 账号物理删除必须经过共享身份与私有事件清理，业务入口不能直接删除User。
    files: ['apps/api/src/**/*.{js,mjs,cjs,ts,mts,cts}'],
    ignores: ['apps/api/src/modules/accounts/account-deletion.ts', '**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}'],
    rules: { 'sesame-notes/account-deletion': 'error' },
  },
  {
    // 领域创建操作对交易、分摊和事件提供同事务边界，其他生产入口不能直接首次物化交易。
    files: ['apps/api/{src,scripts,prisma}/**/*.{js,mjs,cjs,ts,mts,cts}', 'scripts/**/*.{js,mjs,cjs,ts,mts,cts}'],
    ignores: ['apps/api/src/modules/accounting/transaction-creation.ts', '**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}'],
    rules: { 'sesame-notes/transaction-creation': 'error' },
  },
  {
    // 同步事件只有 sync-events 统一入口可以写入，业务及 CLI 不得绕过受保护事务。
    files: ['apps/api/{src,scripts,prisma}/**/*.{js,mjs,cjs,ts,mts,cts}', 'scripts/**/*.{js,mjs,cjs,ts,mts,cts}'],
    ignores: ['apps/api/src/modules/sync-events/event-store.ts', '**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        // 保留 antfu 的 TypeScript 语法约束。
        'TSEnumDeclaration[const=true]',
        'TSExportAssignment',
        {
          selector:
            'MemberExpression[object.type="MemberExpression"]:matches([object.computed=false][object.property.name="syncChange"], [object.computed=true][object.property.value="syncChange"]):matches([computed=false][property.name=/^(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)$/], [computed=true][property.value=/^(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)$/])',
          message: '同步事件写入与清理必须通过 sync-events 公共出口，并使用 withSyncTransaction 事务。',
        },
      ],
    },
  },
);
