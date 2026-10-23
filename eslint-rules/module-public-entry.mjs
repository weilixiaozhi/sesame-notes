import { dirname, resolve, sep } from 'node:path';

/**
 * 禁止跨模块 deep import 的自定义 ESLint 规则。
 *
 * 设计意图：模块边界（modules/<name>/）只通过公共出口 index.js 对外暴露，
 * 防止其他模块直接引用内部文件导致依赖方向失控。
 * 通过规范化后的文件路径判断 source/target 所属模块，不依赖相对路径层级。
 * 公共出口与内部文件仍遵守依赖方向，Admin 接口层的契约不得由页面目录提供。
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: '跨模块导入必须使用模块公共出口（index.js），禁止 deep import 模块内部文件',
    },
    messages: {
      deepImport: '跨模块导入 "{{source}}" 必须改为模块公共出口（index.js）（禁止 deep import 模块内部文件）',
      reverseDependency: '依赖 "{{source}}" 违反架构方向：基础设施不得依赖业务或页面，业务不得依赖应用组装入口。',
      testOnlyEntry: '测试出口 "{{source}}" 仅允许测试文件使用，生产入口不得转发或引用。',
      maintenanceEntry: '测试初始化 "{{source}}" 仅允许受控测试 CLI 与测试文件使用。',
    },
  },

  create(context) {
    /** 校验单个导入源字符串；非相对路径或非跨模块目标直接放行。 */
    function checkSource(node, source) {
      if (typeof source !== 'string' || !source.startsWith('.')) return;
      const importer = moduleOwner(context.filename);
      const targetPath = resolve(dirname(context.filename), source);
      const target = moduleOwner(targetPath);
      const importerPath = context.filename.replaceAll('\\', '/');
      const normalizedTarget = targetPath.replaceAll('\\', '/');
      // 初始化能力只连接测试 CLI，不能经业务模块或生产装配重新暴露。
      if (/\/apps\/api\/src\/admin-test-initialization\.[^/]+$/.test(normalizedTarget)) {
        const controlledCli = /\/apps\/api\/src\/admin-test-bootstrap\.[^/]+$/.test(importerPath);
        const testFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(importerPath);
        if (controlledCli || testFile) return;
        context.report({ node, messageId: 'maintenanceEntry', data: { source } });
        return;
      }
      // 测试专用出口不进入生产 API，只有明确的测试文件可从模块外消费。
      if (target?.path.replace(/\.[^.]+$/, '') === 'testing') {
        if (/\/(?:test|tests)\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(importerPath)) return;
        context.report({ node, messageId: 'testOnlyEntry', data: { source } });
        return;
      }
      // 目录名只用于执行已明确的依赖方向约定，公共出口不能成为反向依赖的豁免。
      const sharedToBusiness = importerPath.includes('/src/shared/') && target;
      const businessToEntry =
        importer &&
        /\/src\/(?:app|server(?:-recover)?|admin-(?:bootstrap|recover|migration-prepare|test-bootstrap)|account-delete|maintenance|shutdown)\.[^/]+$/.test(
          normalizedTarget,
        );
      const eventToBusiness =
        importer?.root.replaceAll('\\', '/').endsWith('/modules/sync-events') &&
        target &&
        importer.root !== target.root;
      // Admin 响应契约属于接口边界，不能由页面组件目录反向提供；边界测试可同时验收两层。
      const adminApiToPresentation =
        /\/apps\/admin\/src\/api\//.test(importerPath) &&
        !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(importerPath) &&
        /\/apps\/admin\/src\/(?:features|components|app)(?:\/|\.|$)/.test(normalizedTarget);
      if (sharedToBusiness || businessToEntry || eventToBusiness || adminApiToPresentation) {
        context.report({ node, messageId: 'reverseDependency', data: { source } });
        return;
      }
      if (!target || importer?.root === target.root) return;
      // 出口判定：目标必须是模块根目录下的 index 文件（去扩展名后比较）
      const targetBase = target.path.replace(/\.[^.]+$/, '');
      if (!target.path.includes('/') && targetBase === 'index') return;
      context.report({
        node,
        messageId: 'deepImport',
        data: {
          source,
        },
      });
    }

    return {
      // 静态 import 声明
      ImportDeclaration(node) {
        checkSource(node, node.source.value);
      },
      // 动态 import('...') 表达式，保持与静态导入同样的约束
      ImportExpression(node) {
        if (node.source && node.source.type === 'Literal') {
          checkSource(node, node.source.value);
        }
      },
      // re-export 与静态 import 受同一模块边界约束
      ExportNamedDeclaration(node) {
        if (node.source) checkSource(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        checkSource(node, node.source.value);
      },
    };
  },
};

/** 提取规范化文件路径所属的 src/modules/<name> 根与模块内路径。 */
function moduleOwner(filePath) {
  const segments = resolve(filePath).split(sep);
  const modulesIndex = segments.findLastIndex(
    (segment, index) => segment === 'modules' && segments[index - 1] === 'src',
  );
  if (modulesIndex < 0 || !segments[modulesIndex + 1]) return null;
  return {
    root: segments.slice(0, modulesIndex + 2).join(sep),
    path: segments.slice(modulesIndex + 2).join('/'),
  };
}
