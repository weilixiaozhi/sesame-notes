/**
 * 手写源码依赖图、循环检测及导出用量分析；文件环和无法解析的相对导入导致失败。
 * node scripts/check/analyze-deps.mjs [--out <json路径>]，默认输出 Temp/arch-analysis.json。
 */
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const EXCLUDE_CORE = /(?:^|\/)(?:node_modules|dist|coverage)(?:\/|$)|\.d\.[cm]?ts$/;
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const GENERATED = /generated\//;

// 手写源码与消费方共同参与依赖图、SCC 和符号用量分析；生成源码单列计数，不进入图。
const CORE_DIRS = ['apps/api/src', 'apps/web/src', 'apps/admin/src', 'packages/api-client/src'];
const CONSUMER_DIRS = ['apps', 'packages', 'scripts', 'eslint-rules'];

/** 收集目录下全部手写或生成源码，返回相对 ROOT 的路径列表；根目录只扫描直属文件。 */
function collectFiles(dirs, exclude) {
  try {
    const files = [];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      /** 遍历源码目录，排除依赖、缓存与构建产物。 */
      const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (['node_modules', '.cache', 'dist', 'build', 'coverage', 'Temp'].includes(entry.name)) continue;
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) {
            if (dir !== '.') walk(full);
          } else if (SOURCE_FILE.test(entry.name) && !exclude.test(full.replaceAll('\\', '/'))) {
            files.push(full.replaceAll('\\', '/'));
          }
        }
      };
      walk(dir);
    }
    return [...new Set(files)].sort();
  } catch (cause) {
    throw new Error('依赖源码清单读取失败，请检查扫描路径', { cause });
  }
}

/** 解析模块说明符为仓库内目标文件；外部依赖返回 null（workspace 包映射到其 src/index.ts） */
function resolveSpecifier(fromFile, spec) {
  try {
    if (spec.startsWith('.')) {
      const base = path.resolve(path.dirname(fromFile), spec);
      const sourceExtensions = { '.js': '.ts', '.mjs': '.mts', '.cjs': '.cts', '.jsx': '.tsx' };
      const runtimeExtension = path.extname(base);
      const sourceExtension = sourceExtensions[runtimeExtension];
      // 显式运行时后缀映射到源码，目录导入只接受实际存在的入口文件。
      const extensions = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'];
      const candidates = [
        base,
        ...(sourceExtension ? [base.slice(0, -runtimeExtension.length) + sourceExtension] : []),
        ...extensions.map((extension) => `${base}.${extension}`),
        ...extensions.map((extension) => path.join(base, `index.${extension}`)),
      ];
      for (const candidate of candidates) {
        const rel = path.relative(ROOT, candidate).replaceAll('\\', '/');
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile() && !EXCLUDE_CORE.test(rel)) return rel;
      }
      return null;
    }
    if (spec === '@sesame-notes/api-client') return 'packages/api-client/src/index.ts';
    if (spec === '@sesame-notes/api-contract') return 'packages/api-contract/package.json'; // 数据包：无代码可解析
    return null;
  } catch (cause) {
    throw new Error(`源码依赖解析失败：${fromFile} 引用 ${spec}，请检查文件访问权限。`, { cause });
  }
}

/** 用 TS 编译器解析单文件：返回 { imports, exports, dynamicImports } */
function parseFile(rel) {
  const abs = path.join(ROOT, rel);
  let sf;
  try {
    const text = fs.readFileSync(abs, 'utf8');
    sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  } catch (cause) {
    throw new Error(`源码读取或解析失败：${rel}，请检查文件状态。`, { cause });
  }
  const imports = []; // { spec, symbols: string[], typeOnly }
  const exports = []; // { spec|null, symbols: [{name, alias}], typeOnly }
  const dynamicImports = [];
  const opaqueImports = [];

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier.text;
      const symbols = [];
      if (node.importClause) {
        // 默认导入的本地名称可以任意命名，其来源模块符号始终是 default。
        if (node.importClause.name) symbols.push('default');
        const nb = node.importClause.namedBindings;
        if (nb) {
          if (ts.isNamespaceImport(nb)) symbols.push(`* as ${nb.name.text}`);
          else nb.elements.forEach((el) => symbols.push(el.propertyName ? el.propertyName.text : el.name.text));
        }
      }
      const named = node.importClause?.namedBindings;
      const namedTypeOnly =
        named &&
        ts.isNamedImports(named) &&
        named.elements.length > 0 &&
        named.elements.every((element) => element.isTypeOnly) &&
        !node.importClause?.name;
      imports.push({ spec, symbols, typeOnly: !!node.importClause?.isTypeOnly || !!namedTypeOnly });
    } else if (ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier?.text ?? null;
      const symbols = [];
      const clause = node.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        clause.elements.forEach((el) =>
          symbols.push(el.propertyName ? `${el.propertyName.text} as ${el.name.text}` : el.name.text),
        );
      }
      const namedTypeOnly =
        clause &&
        ts.isNamedExports(clause) &&
        clause.elements.length > 0 &&
        clause.elements.every((element) => element.isTypeOnly);
      exports.push({ spec, symbols, typeOnly: !!node.isTypeOnly || !!namedTypeOnly, star: !clause });
    } else if (ts.isImportCall(node)) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) dynamicImports.push(arg.text);
      else opaqueImports.push({ kind: 'dynamic', line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (expression && ts.isStringLiteralLike(expression)) {
        imports.push({ spec: expression.text, symbols: [`* as ${node.name.text}`], typeOnly: node.isTypeOnly });
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      // import('./model.js').Entity 属于编译依赖；typeof import() 同样不执行模块。
      let qualifier = node.qualifier;
      while (qualifier && ts.isQualifiedName(qualifier)) qualifier = qualifier.left;
      imports.push({
        spec: node.argument.literal.text,
        symbols: qualifier ? [qualifier.text] : ['* as importType'],
        typeOnly: true,
        kind: 'import-type',
      });
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) {
        // CommonJS 无静态导出声明时仍保留依赖边；保守把目标出口视为消费。
        imports.push({ spec: arg.text, symbols: ['* as require'], typeOnly: false, kind: 'require' });
      } else
        opaqueImports.push({ kind: 'require', line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  // 本地导出符号（export function/class/const/interface/type/enum 及 export default）
  const localExports = [];
  const visitExports = (node) => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      // 默认组件的模块导出名为 default，声明名称仅用于文件内部引用。
      if (node.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword))
        localExports.push('default');
      else if (node.name) localExports.push(node.name.text);
    } else if (ts.isInterfaceDeclaration(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
      localExports.push(node.name.text);
    else if (ts.isTypeAliasDeclaration(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
      localExports.push(node.name.text);
    else if (ts.isEnumDeclaration(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
      localExports.push(node.name.text);
    else if (ts.isVariableStatement(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const d of node.declarationList.declarations) if (ts.isIdentifier(d.name)) localExports.push(d.name.text);
    } else if (ts.isExportAssignment(node)) {
      localExports.push('default');
    }
    ts.forEachChild(node, visitExports);
  };
  ts.forEachChild(sf, visitExports);

  return { imports, exports, dynamicImports, opaqueImports, localExports };
}

/** Tarjan 强连通分量：返回所有 size>1（或含自环）的 SCC */
function findSccs(nodes, adjacency) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  let counter = 0;

  const strongconnect = (v) => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adjacency.get(v) ?? []) {
      if (!index.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1 || adjacency.get(v)?.includes(v)) sccs.push(comp);
    }
  };
  for (const n of nodes) if (!index.has(n)) strongconnect(n);
  return sccs;
}

// ---------- 主流程 ----------
try {
  const outArgIdx = process.argv.indexOf('--out');
  const outPath = outArgIdx >= 0 ? process.argv[outArgIdx + 1] : path.join(ROOT, 'Temp/arch-analysis.json');
  if (!outPath || outPath.startsWith('--')) throw new Error('--out 必须提供输出文件路径');

  const rawCoreFiles = collectFiles(CORE_DIRS, EXCLUDE_CORE);
  const generatedFiles = rawCoreFiles.filter((file) => GENERATED.test(file));
  const generatedFileSet = new Set(generatedFiles);
  const coreFiles = rawCoreFiles.filter((file) => !generatedFileSet.has(file));
  const consumerFiles = collectFiles([...CONSUMER_DIRS, '.'], EXCLUDE_CORE).filter(
    (f) => !CORE_DIRS.some((d) => f.startsWith(`${d}/`)) && !GENERATED.test(f),
  );
  const allFiles = [...coreFiles, ...consumerFiles];

  const parsed = new Map();
  for (const f of allFiles) parsed.set(f, parseFile(f));

  // 构建边：from -> {to, spec, symbols, typeOnly}；外部依赖单独统计
  const edges = [];
  const externalUse = new Map(); // spec -> {count, files:Set}
  const unresolved = new Map(); // spec -> 来源文件列表（相对路径解析失败）

  for (const [from, info] of parsed) {
    // kind 区分边来源：import 声明是最终消费种子，re-export 只做传播，动态导入保守全量
    const specInfos = [
      ...info.imports.map((i) => ({
        spec: i.spec,
        symbols: i.symbols,
        typeOnly: i.typeOnly,
        kind: i.kind ?? 'import',
      })),
      ...info.exports
        .filter((e) => e.spec)
        .map((e) => ({
          spec: e.spec,
          symbols: e.symbols,
          typeOnly: e.typeOnly,
          star: !!e.star,
          kind: 'reexport',
        })),
      ...info.dynamicImports.map((s) => ({ spec: s, symbols: [], typeOnly: false, kind: 'dynamic' })),
    ];
    for (const si of specInfos) {
      const target = resolveSpecifier(from, si.spec);
      if (target) {
        if (!GENERATED.test(target))
          edges.push({
            from,
            to: target,
            spec: si.spec,
            symbols: si.symbols,
            typeOnly: si.typeOnly,
            star: !!si.star,
            kind: si.kind,
          });
      } else if (si.spec.startsWith('.')) {
        if (!unresolved.has(si.spec)) unresolved.set(si.spec, new Set());
        unresolved.get(si.spec).add(from);
      } else if (!si.spec.startsWith('node:')) {
        if (!externalUse.has(si.spec)) externalUse.set(si.spec, { count: 0, files: new Set() });
        externalUse.get(si.spec).count += 1;
        externalUse.get(si.spec).files.add(from);
      }
    }
  }

  // 文件级邻接
  const fileNodes = allFiles;
  const fileAdj = new Map(fileNodes.map((n) => [n, []]));
  for (const e of edges) if (fileAdj.has(e.to)) fileAdj.get(e.from).push(e.to);
  const fileSccs = findSccs(fileNodes, fileAdj);

  // 目录级聚合：目录 = 文件相对其包根的目录节点，
  // 消费方（apps/api/test、apps/api/prisma、apps/api/scripts）归入各自目录而非文件路径本身，
  // 模块目录精确到 src/modules/<name> 与 src/shared，packages 精确到包根。
  /** 按实际模块边界聚合目录；测试和工具仍保留独立来源。 */
  function dirOf(rel) {
    const parts = rel.split('/');
    if (parts.length === 1) return '.';
    if (parts[0] === 'apps') {
      if (parts[3] === 'modules' && parts[4]) return parts.slice(0, 5).join('/'); // apps/api/src/modules/<name>
      if (parts[3] === 'shared') return parts.slice(0, 4).join('/'); // apps/api/src/shared
      if (parts[1] === 'api') return parts.slice(0, 3).join('/'); // apps/api/test、prisma、scripts
      return parts.slice(0, 2).join('/');
    }
    if (parts[0] === 'packages') return parts.slice(0, 2).join('/'); // packages/<name>
    if (parts[0] === 'scripts' || parts[0] === 'eslint-rules') return parts[0];
    return parts[0];
  }
  const dirNodes = [...new Set(allFiles.map(dirOf))].sort();
  const dirAdj = new Map(dirNodes.map((n) => [n, new Set()]));
  const dirEdgeCount = new Map(); // `${from}->${to}` -> count
  for (const e of edges) {
    const fromDir = dirOf(e.from);
    const toDir = dirOf(e.to);
    if (fromDir === toDir || !dirAdj.has(toDir)) continue;
    dirAdj.get(fromDir).add(toDir);
    const key = `${fromDir}->${toDir}`;
    dirEdgeCount.set(key, (dirEdgeCount.get(key) ?? 0) + 1);
  }
  const dirAdjArr = new Map();
  for (const [n, set] of dirAdj.entries()) dirAdjArr.set(n, [...set]);
  const dirSccs = findSccs(dirNodes, dirAdjArr);

  /** 在指定文件集合内重算文件环和目录环，避免将测试反向消费误判为生产依赖。 */
  function analyzeScope(files) {
    try {
      const included = new Set(files);
      const scopeEdges = edges.filter((edge) => included.has(edge.from) && included.has(edge.to));
      const adjacency = new Map(files.map((file) => [file, []]));
      const directories = [...new Set(files.map(dirOf))].sort();
      const directoryAdjacency = new Map(directories.map((dir) => [dir, new Set()]));
      const directoryCounts = new Map();
      for (const edge of scopeEdges) {
        adjacency.get(edge.from).push(edge.to);
        const from = dirOf(edge.from);
        const to = dirOf(edge.to);
        if (from === to) continue;
        directoryAdjacency.get(from).add(to);
        const key = `${from}->${to}`;
        const count = directoryCounts.get(key) ?? { from, to, declarations: 0, sourceFiles: new Set() };
        count.declarations++;
        count.sourceFiles.add(edge.from);
        directoryCounts.set(key, count);
      }
      return {
        files,
        edgeCount: scopeEdges.length,
        typeOnlyEdgeCount: scopeEdges.filter((edge) => edge.typeOnly).length,
        fileSccs: findSccs(files, adjacency),
        dirSccs: findSccs(directories, new Map([...directoryAdjacency].map(([dir, targets]) => [dir, [...targets]]))),
        directoryEdges: [...directoryCounts.values()].map(({ sourceFiles, ...edge }) => ({
          ...edge,
          sourceFiles: sourceFiles.size,
        })),
      };
    } catch (cause) {
      throw new Error('分范围依赖统计失败，请检查源码解析结果', { cause });
    }
  }

  /** 测试身份只按稳定路径/后缀确定，生产入口可达性由单独的运行链分析负责。 */
  function sourceRole(file) {
    if (/(?:^|\/)(?:test|tests|__tests__)\//.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) return 'test';
    if (
      file === 'apps/api/src/admin-test-initialization.ts' ||
      /(?:^|\/)(?:testing|[a-z-]*test-bootstrap)\.[cm]?[jt]s$/.test(file)
    )
      return 'test-support';
    return coreFiles.includes(file) ? 'production' : 'tooling';
  }

  const productionFiles = allFiles.filter((file) => sourceRole(file) === 'production');
  const testFiles = allFiles.filter((file) => ['test', 'test-support'].includes(sourceRole(file)));
  const toolingFiles = allFiles.filter((file) => sourceRole(file) === 'tooling');
  const opaqueImports = [...parsed].flatMap(([file, info]) => info.opaqueImports.map((item) => ({ file, ...item })));

  // 每个文件的导出符号清单：本地导出 + re-export（展开别名；star 导出迭代展开到稳定）
  const exportSymbols = new Map(); // file -> [{sym, source}]
  for (const [f, info] of parsed) {
    const list = [];
    for (const s of info.localExports) list.push({ sym: s, source: f });
    for (const e of info.exports) {
      if (e.star) continue;
      for (const alias of e.symbols) {
        const as = alias.includes(' as ') ? alias.split(' as ')[1] : alias;
        list.push({ sym: as, source: e.spec ? (resolveSpecifier(f, e.spec) ?? f) : f });
      }
    }
    exportSymbols.set(f, list);
  }
  // fixpoint：export * from './x.js' 逐轮展开，直到符号集合稳定
  for (;;) {
    let changed = false;
    for (const [f, info] of parsed) {
      const base = exportSymbols.get(f) ?? [];
      for (const e of info.exports) {
        if (!e.star || !e.spec) continue;
        const t = resolveSpecifier(f, e.spec);
        if (!t || !parsed.has(t)) continue;
        const srcExports = exportSymbols.get(t) ?? [];
        const existing = new Set(base.map((x) => x.sym));
        for (const se of srcExports) {
          if (se.sym === 'default') continue;
          if (!existing.has(se.sym)) {
            base.push({ sym: se.sym, source: se.source });
            existing.add(se.sym);
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }

  // ---------- barrel 传递用量分析（从最终 consumer 反向传播符号可达性） ----------
  // 符号 S 是否被"真正使用"：从非 re-export 的真实导入（import 声明、命名空间导入、
  // 动态导入）出发反向传播；named re-export / export * 链上没有任何最终消费者的符号
  // 判为未使用，避免中间 barrel 的 re-export 被误当作消费。
  const isBarrel = (file) => /(?:^|\/)index\.[cm]?[jt]sx?$/.test(file);

  // 每个文件的 named re-export 映射：导出名 -> {target, targetSym}（原名或别名）
  const namedReExports = new Map();
  for (const [f, info] of parsed) {
    const map = new Map();
    for (const e of info.exports) {
      if (!e.spec || e.star) continue;
      for (const alias of e.symbols) {
        const sep = alias.indexOf(' as ');
        const orig = sep >= 0 ? alias.slice(0, sep) : alias;
        const as = sep >= 0 ? alias.slice(sep + 4) : alias;
        const target = resolveSpecifier(f, e.spec);
        if (target && parsed.has(target)) map.set(as, { target, targetSym: orig });
      }
    }
    namedReExports.set(f, map);
  }

  const used = new Set();
  const markUsed = (file, sym) => used.add(`${file}|${sym}`);
  // 命名空间/动态导入无法静态确定访问了哪些符号：保守标记目标全部导出为已使用
  const markAllExports = (file) => {
    for (const s of exportSymbols.get(file) ?? []) markUsed(file, s.sym);
    for (const name of namedReExports.get(file)?.keys() ?? []) markUsed(file, name);
  };

  // 种子：真实导入直接标记来源文件中被导入的符号
  for (const e of edges) {
    if (e.kind === 'reexport' || e.from === e.to) continue;
    if (e.kind === 'dynamic') {
      markAllExports(e.to);
      continue;
    }
    for (const symbol of e.symbols) {
      if (symbol.startsWith('* as ')) markAllExports(e.to);
      else markUsed(e.to, symbol);
    }
  }

  // 传播到不动点：named re-export 与 export * 把"已使用"反向传递到定义处
  for (;;) {
    let changed = false;
    for (const [file, map] of namedReExports) {
      for (const [name, { target, targetSym }] of map) {
        if (!used.has(`${file}|${name}`)) continue;
        const key = `${target}|${targetSym}`;
        if (!used.has(key)) {
          used.add(key);
          changed = true;
        }
      }
    }
    for (const [f, info] of parsed) {
      for (const e of info.exports) {
        if (!e.star || !e.spec) continue;
        const t = resolveSpecifier(f, e.spec);
        if (!t || !parsed.has(t)) continue;
        const targetNames = new Set([
          ...(exportSymbols.get(t) ?? []).map((s) => s.sym),
          ...(namedReExports.get(t)?.keys() ?? []),
        ]);
        for (const name of targetNames) {
          if (name === 'default') continue;
          const key = `${t}|${name}`;
          if (used.has(`${f}|${name}`) && !used.has(key)) {
            used.add(key);
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }

  /** 符号 S 是否被最终消费者直接或经 re-export 链间接使用。 */
  function isSymbolUsed(file, sym) {
    return used.has(`${file}|${sym}`);
  }

  /** 按最终消费方职责传播出口用量，测试引用不能伪装成生产消费。 */
  function collectScopeUsage(role) {
    try {
      const reached = new Set();
      const pending = [];
      /** 每个符号只入队一次，长 barrel 链也不会受固定轮数截断。 */
      function enqueue(file, symbol) {
        const key = `${file}|${symbol}`;
        if (reached.has(key)) return;
        reached.add(key);
        pending.push({ file, symbol });
      }
      for (const edge of edges) {
        const source = sourceRole(edge.from);
        const bucket = source === 'test-support' ? 'test' : source;
        if (bucket !== role || edge.kind === 'reexport' || edge.from === edge.to) continue;
        if (edge.kind === 'dynamic' || edge.symbols.some((symbol) => symbol.startsWith('* as '))) {
          for (const { sym } of exportSymbols.get(edge.to) ?? []) enqueue(edge.to, sym);
        } else {
          for (const symbol of edge.symbols) enqueue(edge.to, symbol);
        }
      }
      for (let position = 0; position < pending.length; position++) {
        const { file, symbol } = pending[position];
        const named = namedReExports.get(file)?.get(symbol);
        if (named) enqueue(named.target, named.targetSym);
        for (const entry of parsed.get(file)?.exports ?? []) {
          if (!entry.star || !entry.spec || symbol === 'default') continue;
          const target = resolveSpecifier(file, entry.spec);
          if ((exportSymbols.get(target) ?? []).some((candidate) => candidate.sym === symbol)) enqueue(target, symbol);
        }
      }
      return reached;
    } catch (cause) {
      throw new Error(`按${role}消费方追踪公共出口失败`, { cause });
    }
  }
  const usageByRole = new Map(['production', 'test', 'tooling'].map((role) => [role, collectScopeUsage(role)]));

  const fileAnalysis = [];
  for (const f of coreFiles) {
    const info = parsed.get(f);
    const syms = [];
    for (const s of info.localExports) {
      syms.push({ sym: s, kind: 'local', used: isSymbolUsed(f, s) });
    }
    for (const e of info.exports) {
      if (e.star) {
        syms.push({ sym: '*', kind: 'star', used: null });
        continue;
      }
      for (const alias of e.symbols) {
        const as = alias.includes(' as ') ? alias.split(' as ')[1] : alias;
        syms.push({ sym: as, kind: e.spec ? 'reexport' : 'local-reexport', used: isSymbolUsed(f, as) });
      }
    }
    fileAnalysis.push({
      file: f,
      role: sourceRole(f),
      generated: GENERATED.test(f),
      symbols: syms.map((symbol) => ({
        ...symbol,
        consumedBy: [...usageByRole].filter(([, symbols]) => symbols.has(`${f}|${symbol.sym}`)).map(([role]) => role),
      })),
      importCount: info.imports.length,
    });
  }

  // 每个文件被导入的次数（入度）
  const inDegree = new Map(fileNodes.map((n) => [n, 0]));
  for (const e of edges) if (inDegree.has(e.to)) inDegree.set(e.to, inDegree.get(e.to) + 1);

  // 目录级单边符号负载：按 from/to 目录对聚合边，符号名按边去重计数（不按导入次数重复计）
  const dirSymbolGroups = new Map();
  for (const e of edges) {
    const fromDir = dirOf(e.from);
    const toDir = dirOf(e.to);
    if (fromDir === toDir) continue;
    const key = `${fromDir}->${toDir}`;
    if (!dirSymbolGroups.has(key)) dirSymbolGroups.set(key, { names: new Set(), edges: 0 });
    const group = dirSymbolGroups.get(key);
    group.edges += 1;
    for (const symbol of e.symbols) group.names.add(symbol);
  }
  const dirEdgeSymbols = [...dirSymbolGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => {
      const [from, to] = key.split('->');
      const names = [...group.names].sort();
      return { from, to, symbols: names.length, names, edges: group.edges };
    });

  const result = {
    meta: { root: ROOT, generatedAt: new Date().toISOString() },
    files: {
      core: coreFiles.length,
      rawCore: rawCoreFiles.length,
      handwrittenCore: coreFiles.length,
      generatedCore: generatedFiles.length,
      consumer: consumerFiles.length,
      total: rawCoreFiles.length + consumerFiles.length,
    },
    coreFiles,
    consumerFiles,
    generatedFiles,
    productionFiles,
    testFiles,
    toolingFiles,
    scopes: {
      production: analyzeScope(productionFiles),
      serverProduction: analyzeScope(productionFiles.filter((file) => file.startsWith('apps/api/src/'))),
      tests: analyzeScope(testFiles),
      tooling: analyzeScope(toolingFiles),
    },
    consumerEdges: edges
      .filter((edge) => ['test', 'test-support', 'tooling'].includes(sourceRole(edge.from)))
      .map((edge) => ({ ...edge, consumerRole: sourceRole(edge.from) })),
    opaqueImports,
    edges,
    externalUse: [...externalUse.entries()]
      .map(([spec, v]) => ({ spec, count: v.count, files: [...v.files].sort() }))
      .sort((a, b) => b.count - a.count),
    unresolved: [...unresolved.entries()].map(([spec, files]) => ({ spec, files: [...files] })),
    fileSccs,
    dirSccs,
    dirEdgeCount: [...dirEdgeCount.entries()].sort((a, b) => b[1] - a[1]),
    fileAnalysis,
    inDegree: [...inDegree.entries()].sort((a, b) => b[1] - a[1]),
    dirEdgeSymbols,
    barrels: [...exportSymbols.entries()].filter(([f]) => isBarrel(f)).map(([f, syms]) => ({ file: f, syms })),
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');

  // ---------- 控制台摘要 ----------
  console.log(
    `文件统计: core=${coreFiles.length} raw=${rawCoreFiles.length} handwritten=${coreFiles.length} generated=${generatedFiles.length} consumer=${consumerFiles.length}`,
  );
  console.log(`边总数: ${edges.length}  未解析相对导入: ${unresolved.size} 种`);
  console.log(
    `生产源码: ${productionFiles.length} 文件；测试及测试支持: ${testFiles.length} 文件；工具: ${toolingFiles.length} 文件`,
  );
  console.log(
    `服务端生产图: ${result.scopes.serverProduction.edgeCount} 条边 / ${result.scopes.serverProduction.fileSccs.length} 个文件环 / ${result.scopes.serverProduction.dirSccs.length} 个目录环`,
  );
  for (const item of opaqueImports)
    console.warn(`静态不可解析的 ${item.kind}: ${item.file}:${item.line}，需人工检查动态加载来源`);
  console.log('\n外部依赖广度（按引用次数）:');
  for (const e of result.externalUse) console.log(`  ${e.spec.padEnd(30)} ${e.count} 次 / ${e.files.length} 文件`);
  console.log('\n文件级 SCC:');
  for (const scc of fileSccs) console.log('  [', scc.join(', '), ']');
  console.log('目录级 SCC:');
  for (const scc of dirSccs) console.log('  [', scc.join(', '), ']');
  console.log('\n输出:', outPath);

  // 只拦截真实文件环和缺失依赖；目录聚合结果供审阅，深导入由 ESLint 检查。
  const violations = [];
  if (fileSccs.length > 0) violations.push(`文件级循环依赖: ${fileSccs.length} 个 SCC`);
  if (unresolved.size > 0) violations.push(`未解析相对导入: ${unresolved.size} 种`);
  if (violations.length > 0) {
    console.error('架构依赖检查失败:');
    for (const v of violations) console.error(`  - ${v}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error('架构依赖分析无法完成，请检查输出路径与源码状态。', error);
  process.exitCode = 1;
}
