import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  checkContractCompatibility,
  checkCurrentContract,
  checkRepositoryContract,
  readContractBaselines,
  runOpenApiGenerator,
} from '../check/contract-check.mjs';
import { findContractBreakingChanges } from '../lib/contract-compatibility.mjs';

/** 最小真实 OpenAPI 结构使请求和响应的兼容方向都能被独立验证。 */
function contract(
  request = { type: 'string', maxLength: 64 },
  response = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
) {
  return {
    openapi: '3.0.3',
    info: { version: '1.0.0' },
    components: { schemas: { Result: response } },
    paths: {
      '/items': {
        get: {
          operationId: 'getItems',
          parameters: [{ in: 'query', name: 'cursor', schema: request }],
          responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Result' } } } } },
        },
      },
    },
  };
}

test('兼容门禁允许输入放宽、文案变化和新增可选字段', () => {
  const baseline = contract();
  const candidate = contract({ type: 'string', maxLength: 256 });
  candidate.paths['/items'].get.summary = '读取列表';
  candidate.components.schemas.Result.properties.name = { type: 'string' };
  assert.deepEqual(findContractBreakingChanges(baseline, candidate), []);
});

test('兼容门禁拒绝输入范围缩窄、新增必填参数和删除操作', () => {
  assert.match(
    findContractBreakingChanges(contract(), contract({ type: 'string', maxLength: 32 })).join('\n'),
    /maxLength/,
  );
  const required = contract();
  required.paths['/items'].get.parameters.push({
    in: 'query',
    name: 'tenant',
    required: true,
    schema: { type: 'string' },
  });
  assert.match(findContractBreakingChanges(contract(), required).join('\n'), /新增必填参数/);
  assert.match(findContractBreakingChanges(contract(), { paths: {} }).join('\n'), /操作被删除/);
});

test('兼容门禁沿引用追踪响应变化，拒绝类型变化和丢失必需字段', () => {
  assert.match(
    findContractBreakingChanges(
      contract(),
      contract(undefined, { type: 'object', properties: { id: { type: 'string' } } }),
    ).join('\n'),
    /必需字段/,
  );
  assert.match(
    findContractBreakingChanges(
      contract(),
      contract(undefined, { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } }),
    ).join('\n'),
    /类型/,
  );
});

test('兼容门禁区分请求与响应枚举的扩大方向', () => {
  const narrow = { type: 'string', enum: ['one'] };
  const wide = { type: 'string', enum: ['one', 'two'] };
  assert.deepEqual(findContractBreakingChanges(contract(narrow), contract(wide)), []);
  assert.match(findContractBreakingChanges(contract(wide), contract(narrow)).join('\n'), /枚举/);
  assert.match(findContractBreakingChanges(contract(undefined, narrow), contract(undefined, wide)).join('\n'), /枚举/);
  assert.deepEqual(findContractBreakingChanges(contract(undefined, wide), contract(undefined, narrow)), []);
});

test('兼容门禁拒绝响应新增不兼容联合分支及无法解析的引用', () => {
  const narrow = { anyOf: [{ type: 'string' }, { type: 'null' }] };
  const wide = { anyOf: [{ type: 'string' }, { type: 'null' }, { type: 'integer' }] };
  assert.match(
    findContractBreakingChanges(contract(undefined, narrow), contract(undefined, wide)).join('\n'),
    /联合类型/,
  );
  const broken = contract();
  broken.components.schemas = {};
  assert.throws(() => findContractBreakingChanges(contract(), broken), /历史契约兼容性分析失败/);
});

test('兼容门禁不把同名业务字段当注释忽略，并检查认证定义与成功状态', () => {
  const baseline = contract(undefined, { type: 'object', properties: { description: { type: 'string' } } });
  const changed = contract(undefined, { type: 'object', properties: { description: { type: 'integer' } } });
  assert.match(findContractBreakingChanges(baseline, changed).join('\n'), /description/);
  const secured = {
    ...contract(),
    components: { ...contract().components, securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
  };
  assert.match(findContractBreakingChanges(secured, contract()).join('\n'), /认证方式/);
  const success = contract();
  success.paths['/items'].get.responses['201'] = success.paths['/items'].get.responses['200'];
  assert.match(findContractBreakingChanges(contract(), success).join('\n'), /新增成功状态/);
});

test('兼容门禁检查联合类型外层约束和可空范围', () => {
  const schema = { anyOf: [{ type: 'string', enum: ['one', 'two'] }] };
  assert.match(
    findContractBreakingChanges(contract(schema), contract({ ...schema, maxLength: 2 })).join('\n'),
    /maxLength/,
  );
  assert.match(
    findContractBreakingChanges(contract(undefined, schema), contract(undefined, { ...schema, nullable: true })).join(
      '\n',
    ),
    /联合类型/,
  );
});

test('兼容门禁按自有属性检查特殊字段，不能把对象原型当作 schema', () => {
  try {
    const closed = { type: 'object', additionalProperties: false, properties: {} };
    for (const name of ['constructor', 'toString', '__proto__']) {
      const named = { ...closed, properties: Object.fromEntries([[name, { type: 'string' }]]) };
      assert.match(
        findContractBreakingChanges(contract(named), contract(closed)).join('\n'),
        /字段 .* 被禁止/,
        `删除请求字段 ${name} 必须拒绝`,
      );
      assert.match(
        findContractBreakingChanges(contract(undefined, closed), contract(undefined, named)).join('\n'),
        /字段 .* 被禁止/,
        `封闭响应新增字段 ${name} 必须拒绝`,
      );
      const unresolved = contract();
      unresolved.paths['/items'].get.responses[200].content['application/json'].schema.$ref =
        `#/components/schemas/${name}`;
      assert.throws(() => findContractBreakingChanges(contract(), unresolved), /历史契约兼容性分析失败/);
    }
  } catch (cause) {
    throw new Error('特殊属性名的契约边界回归失败', { cause });
  }
});

const current = JSON.stringify({ info: { version: '1.0.0' }, paths: {} });
test('契约校验版本一致性，允许版本正常演进', () => {
  assert.doesNotThrow(() => checkCurrentContract(current, current, '1.0.0'));
  assert.throws(() => checkCurrentContract(current, `${current}\n`, '1.0.0'), /不一致/);
  assert.throws(() => checkCurrentContract(current, current, '2.0.0'), /不一致/);
  const changed = current.replace('1.0.0', '2.0.0');
  assert.throws(() => checkCurrentContract(changed, changed, '1.0.0'), /不一致/);
  assert.doesNotThrow(() => checkCurrentContract(changed, changed, '2.0.0'));
});

test('固定基线门禁直接拒绝破坏性变更，比较不修改快照', () => {
  const baseline = contract();
  const original = JSON.stringify(baseline);
  assert.doesNotThrow(() => checkContractCompatibility(baseline, contract({ type: 'string', maxLength: 256 })));
  assert.throws(() => checkContractCompatibility(baseline, { paths: {} }), /操作被删除/);
  assert.throws(() => checkContractCompatibility(baseline, contract({ type: 'string', maxLength: 32 })), /maxLength/);
  assert.equal(JSON.stringify(baseline), original);
});

/** 从嵌套错误中保留完整诊断，便于确认校验失败的具体原因。 */
function baselineErrorMessages(error) {
  const messages = [];
  for (let current = error; current; current = current.cause) messages.push(current.message);
  return messages.join('\n');
}

/** 创建仅含契约文件的磁盘夹具，所有文件及清理范围固定在根目录 Temp。 */
function baselineFixture(t) {
  const temp = resolve(dirname(fileURLToPath(import.meta.url)), '../../Temp');
  try {
    mkdirSync(temp, { recursive: true });
    const root = mkdtempSync(join(temp, 'contract-baseline-'));
    t.after(() => {
      try {
        const target = resolve(root);
        if (!target.startsWith(`${temp}${sep}`)) throw new Error('契约测试临时目录超出范围');
        rmSync(target, { recursive: true, force: true });
      } catch (cause) {
        throw new Error('契约测试临时目录清理失败', { cause });
      }
    });
    const directory = join(root, 'packages/api-contract');
    mkdirSync(directory, { recursive: true });
    const { entry, content } = writeBaselineSnapshot(root, contract());
    const manifest = { schemaVersion: 2, snapshots: [entry] };
    const metadata = join(directory, 'compatibility-baseline.json');
    writeFileSync(metadata, JSON.stringify(manifest));
    writeFileSync(join(directory, 'openapi.json'), content);
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: entry.version }));
    return { root, directory, entry, content, manifest, metadata, snapshot: join(root, entry.path) };
  } catch (cause) {
    throw new Error('契约快照测试夹具创建失败', { cause });
  }
}

/** 独立快照的内容、版本和摘要均来自同一份明确的接口定义。 */
function writeBaselineSnapshot(root, document, path = 'packages/api-contract/compatibility-baseline.openapi.json') {
  try {
    const content = `${JSON.stringify(document)}\n`;
    const entry = {
      id: `supported-${document.info.version}`,
      version: document.info.version,
      status: 'supported',
      path,
      sha256: createHash('sha256').update(content).digest('hex'),
      review: '测试中的独立审阅快照',
    };
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
    return { entry, content };
  } catch (cause) {
    throw new Error('契约快照测试文件写入失败', { cause });
  }
}

/** Git 只用于创建新仓与浅克隆夹具；身份和签名设置仅作用于本次进程。 */
function fixtureGit(root, args) {
  try {
    return execFileSync(
      'git',
      [
        '-c',
        'user.name=Contract Fixture',
        '-c',
        'user.email=contract-fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        `core.hooksPath=${join(root, 'empty-hooks')}`,
        ...args,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        },
      },
    );
  } catch (cause) {
    throw new Error(`契约测试 Git 夹具准备失败：${args.join(' ')}`, { cause });
  }
}

test('支持快照直接随源码读取，无 Git 安装和仓库元数据也能验证', (t) => {
  try {
    const { root, directory, entry, content, snapshot } = baselineFixture(t);
    assert.equal(existsSync(join(root, '.git')), false);
    // 行尾差异不影响摘要；当前生成文件不能替换受支持快照。
    writeFileSync(snapshot, content.replaceAll('\n', '\r\n'));
    writeFileSync(join(directory, 'openapi.json'), JSON.stringify({ paths: {} }));
    assert.deepEqual(readContractBaselines(root), [{ entry, document: contract() }]);
    // 子进程没有 PATH，确保任何隐式 Git 调用都会失败；仅导入读取器，不执行生成器。
    const script = `import { readContractBaselines } from ${JSON.stringify(new URL('../check/contract-check.mjs', import.meta.url).href)}; console.log(JSON.stringify(readContractBaselines(${JSON.stringify(root)}).map(({entry}) => entry.id)));`;
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: root,
      env: { ...process.env, PATH: '', Path: '' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.deepEqual(JSON.parse(output), [entry.id]);
    assert.equal(readFileSync(snapshot, 'utf8'), content.replaceAll('\n', '\r\n'));
  } catch (cause) {
    throw new Error('随源码分发契约快照测试失败', { cause });
  }
});

test('支持快照适用于只有初始提交的新仓库及深度一的浅克隆', (t) => {
  try {
    const { root, entry } = baselineFixture(t);
    fixtureGit(root, ['init', '--quiet']);
    fixtureGit(root, ['add', 'packages']);
    fixtureGit(root, ['commit', '--quiet', '-m', '契约测试初始快照']);
    assert.equal(fixtureGit(root, ['rev-list', '--count', 'HEAD']).trim(), '1');
    assert.deepEqual(
      readContractBaselines(root).map(({ entry }) => entry.id),
      [entry.id],
    );
    // 第二次提交仅用于证明浅克隆确实缺失历史，而非完整的一次提交仓库。
    writeFileSync(join(root, 'fixture.txt'), '仅用于浅克隆测试\n');
    fixtureGit(root, ['add', 'fixture.txt']);
    fixtureGit(root, ['commit', '--quiet', '-m', '契约测试浅克隆边界']);
    const clone = join(root, 'shallow-copy');
    fixtureGit(root, ['clone', '--quiet', '--depth', '1', pathToFileURL(root).href, clone]);
    assert.equal(fixtureGit(clone, ['rev-parse', '--is-shallow-repository']).trim(), 'true');
    assert.equal(fixtureGit(clone, ['rev-list', '--count', 'HEAD']).trim(), '1');
    assert.deepEqual(
      readContractBaselines(clone).map(({ entry }) => entry.id),
      [entry.id],
    );
    assert.deepEqual(
      checkRepositoryContract(clone, () => readFileSync(join(clone, 'packages/api-contract/openapi.json'), 'utf8')),
      [entry.id],
    );
  } catch (cause) {
    throw new Error('新仓库与浅克隆契约快照测试失败', { cause });
  }
});

test('支持快照拒绝内容损坏、摘要不符、版本不符及无法解析的文件', (t) => {
  try {
    const { root, entry, content, manifest, metadata, snapshot } = baselineFixture(t);
    writeFileSync(snapshot, content.replace('maxLength', 'minLength'));
    assert.throws(
      () => readContractBaselines(root),
      (error) => /摘要/.test(baselineErrorMessages(error)),
    );
    writeFileSync(snapshot, content);
    writeFileSync(metadata, JSON.stringify({ ...manifest, snapshots: [{ ...entry, sha256: '0'.repeat(64) }] }));
    assert.throws(
      () => readContractBaselines(root),
      (error) => /摘要/.test(baselineErrorMessages(error)),
    );
    writeFileSync(metadata, JSON.stringify({ ...manifest, snapshots: [{ ...entry, version: '2.0.0' }] }));
    assert.throws(
      () => readContractBaselines(root),
      (error) => /版本/.test(baselineErrorMessages(error)),
    );
    const malformed = '{invalid-json';
    writeFileSync(snapshot, malformed);
    writeFileSync(
      metadata,
      JSON.stringify({
        ...manifest,
        snapshots: [{ ...entry, sha256: createHash('sha256').update(malformed).digest('hex') }],
      }),
    );
    assert.throws(() => readContractBaselines(root), /快照/);
    rmSync(snapshot);
    assert.throws(() => readContractBaselines(root), /快照/);
  } catch (cause) {
    throw new Error('契约快照完整性验证测试失败', { cause });
  }
});

test('支持快照拒绝空清单、格式错误、无效身份及重复身份和文件', (t) => {
  try {
    const { root, entry, metadata } = baselineFixture(t);
    const invalid = [
      null,
      {},
      { schemaVersion: 1, snapshots: [entry] },
      { schemaVersion: 2, snapshots: [] },
      { schemaVersion: 2, snapshots: [null] },
      { schemaVersion: 2, snapshots: [[]] },
      { schemaVersion: 2, snapshots: [{ ...entry, id: '' }] },
      { schemaVersion: 2, snapshots: [{ ...entry, id: 42 }] },
      { schemaVersion: 2, snapshots: [{ ...entry, version: 'latest' }] },
      { schemaVersion: 2, snapshots: [{ ...entry, sha256: 'not-a-sha256' }] },
      { schemaVersion: 2, snapshots: [{ ...entry, status: 'ignored' }] },
      { schemaVersion: 2, snapshots: [{ ...entry, review: '  ' }] },
      { schemaVersion: 2, snapshots: [entry, { ...entry, path: 'packages/api-contract/releases/extra.openapi.json' }] },
      { schemaVersion: 2, snapshots: [entry, { ...entry, id: 'supported-extra' }] },
    ];
    for (const manifest of invalid) {
      writeFileSync(metadata, JSON.stringify(manifest));
      assert.throws(() => readContractBaselines(root), /快照/, JSON.stringify(manifest));
    }
    writeFileSync(metadata, '{invalid-json');
    assert.throws(() => readContractBaselines(root), /快照/);
  } catch (cause) {
    throw new Error('契约快照清单验证测试失败', { cause });
  }
});

test('支持快照必须包含可检查的 OpenAPI 文档与非空接口集合', (t) => {
  try {
    const { root, entry, metadata, snapshot } = baselineFixture(t);
    const invalid = [
      null,
      [],
      {},
      { ...contract(), openapi: '2.0.0' },
      { ...contract(), openapi: '3.latest' },
      { ...contract(), paths: null },
      { ...contract(), paths: [] },
      { ...contract(), paths: {} },
      { ...contract(), info: null },
    ];
    for (const document of invalid) {
      const content = JSON.stringify(document);
      writeFileSync(snapshot, content);
      writeFileSync(
        metadata,
        JSON.stringify({
          schemaVersion: 2,
          snapshots: [{ ...entry, sha256: createHash('sha256').update(content).digest('hex') }],
        }),
      );
      assert.throws(() => readContractBaselines(root), /快照/, content);
    }
  } catch (cause) {
    throw new Error('契约快照文档结构测试失败', { cause });
  }
});

test('支持快照路径仅允许独立基线文件或发布目录中的文件', (t) => {
  try {
    const { root, entry, metadata } = baselineFixture(t);
    for (const path of [
      '../private.openapi.json',
      '/private.openapi.json',
      'C:/private.openapi.json',
      'packages/api-contract/openapi.json',
      'packages/api-contract/releases/../private.openapi.json',
      'packages\\api-contract\\compatibility-baseline.openapi.json',
      'packages/api-contract/releases/nested/private.openapi.json',
    ]) {
      writeFileSync(metadata, JSON.stringify({ schemaVersion: 2, snapshots: [{ ...entry, path }] }));
      assert.throws(
        () => readContractBaselines(root),
        (error) => /路径/.test(baselineErrorMessages(error)),
        path,
      );
    }
  } catch (cause) {
    throw new Error('契约快照路径边界测试失败', { cause });
  }
});

test('支持快照拒绝经目录链接读取清单或快照，文件不能被目录替代', (t) => {
  try {
    const manifestFixture = baselineFixture(t);
    const linkedPackages = join(manifestFixture.root, 'linked-packages');
    renameSync(join(manifestFixture.root, 'packages'), linkedPackages);
    symlinkSync(
      linkedPackages,
      join(manifestFixture.root, 'packages'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    assert.throws(
      () => readContractBaselines(manifestFixture.root),
      (error) => /链接/.test(baselineErrorMessages(error)),
    );

    const snapshotFixture = baselineFixture(t);
    const target = join(snapshotFixture.root, 'linked-snapshots');
    mkdirSync(target);
    writeFileSync(join(target, 'extra.openapi.json'), snapshotFixture.content);
    symlinkSync(target, join(snapshotFixture.directory, 'releases'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(
      snapshotFixture.metadata,
      JSON.stringify({
        schemaVersion: 2,
        snapshots: [{ ...snapshotFixture.entry, path: 'packages/api-contract/releases/extra.openapi.json' }],
      }),
    );
    assert.throws(
      () => readContractBaselines(snapshotFixture.root),
      (error) => /链接/.test(baselineErrorMessages(error)),
    );

    const directoryFixture = baselineFixture(t);
    rmSync(directoryFixture.snapshot);
    mkdirSync(directoryFixture.snapshot);
    assert.throws(
      () => readContractBaselines(directoryFixture.root),
      (error) => /文件/.test(baselineErrorMessages(error)),
    );
  } catch (cause) {
    throw new Error('契约快照文件系统边界测试失败', { cause });
  }
});

test('支持快照全部参加仓库门禁，追加新基线仍保留旧客户端约定', (t) => {
  try {
    const { root, directory, metadata } = baselineFixture(t);
    const older = writeBaselineSnapshot(root, contract({ type: 'string', maxLength: 128 }));
    const newerDocument = contract({ type: 'string', maxLength: 64 });
    newerDocument.info.version = '2.0.0';
    const newer = writeBaselineSnapshot(root, newerDocument, 'packages/api-contract/releases/2.0.0.openapi.json');
    newer.entry.status = 'released';
    const artifactPath = join(directory, 'openapi.json');
    writeFileSync(artifactPath, newer.content);
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: newer.entry.version }));
    // 不兼容快照放在首位和末位都必须失败，避免检查器只验证其中一份。
    for (const snapshots of [
      [older.entry, newer.entry],
      [newer.entry, older.entry],
    ]) {
      writeFileSync(metadata, JSON.stringify({ schemaVersion: 2, snapshots }));
      assert.throws(
        () => checkRepositoryContract(root, () => newer.content),
        (error) =>
          /supported-1\.0\.0/.test(baselineErrorMessages(error)) && /maxLength/.test(baselineErrorMessages(error)),
      );
    }
    assert.equal(readFileSync(artifactPath, 'utf8'), newer.content);
    assert.equal(readFileSync(join(root, older.entry.path), 'utf8'), older.content);
    newerDocument.paths['/items'].get.parameters[0].schema.maxLength = 128;
    const compatible = `${JSON.stringify(newerDocument)}\n`;
    writeFileSync(artifactPath, compatible);
    assert.deepEqual(
      checkRepositoryContract(root, () => compatible),
      [newer.entry.id, older.entry.id],
    );
  } catch (cause) {
    throw new Error('多份受支持契约快照门禁测试失败', { cause });
  }
});

test('参数content按请求方向检查类型、媒体与编码，不静默退化为空schema', () => {
  try {
    const baseline = contract();
    const parameter = baseline.paths['/items'].get.parameters[0];
    delete parameter.schema;
    parameter.content = { 'application/json': { schema: { type: 'string', maxLength: 64 } } };
    const candidate = structuredClone(baseline);
    const next = candidate.paths['/items'].get.parameters[0];
    next.content['application/json'].schema.maxLength = 128;
    assert.deepEqual(findContractBreakingChanges(baseline, candidate), []);
    next.content['application/json'].schema.type = 'integer';
    assert.match(findContractBreakingChanges(baseline, candidate).join('\n'), /类型/);
    next.content = { 'text/plain': { schema: { type: 'string' } } };
    assert.match(findContractBreakingChanges(baseline, candidate).join('\n'), /媒体类型/);
    delete next.content;
    next.schema = { type: 'string' };
    assert.match(findContractBreakingChanges(baseline, candidate).join('\n'), /schema\/content/);
    delete next.schema;
    next.content = structuredClone(parameter.content);
    next.content['application/json'].encoding = { cursor: { style: 'form' } };
    assert.match(findContractBreakingChanges(baseline, candidate).join('\n'), /媒体编码/);
    next.content['text/plain'] = { schema: { type: 'string' } };
    assert.throws(() => findContractBreakingChanges(baseline, candidate), /历史契约兼容性分析失败/);
  } catch (cause) {
    throw new Error('参数content兼容方向回归失败', { cause });
  }
});

test('认证输入放宽允许匿名或增加候选方案，新增认证要求和收紧scope仍拒绝', () => {
  try {
    const baseline = contract();
    baseline.components.securitySchemes = {
      bearer: { type: 'http', scheme: 'bearer' },
      oauth: { type: 'oauth2', flows: {} },
    };
    baseline.paths['/items'].get.security = [{ bearer: [] }];
    const candidate = structuredClone(baseline);
    candidate.paths['/items'].get.security = [];
    assert.deepEqual(findContractBreakingChanges(baseline, candidate), [], '公开接口仍接受原Bearer请求');
    assert.match(findContractBreakingChanges(candidate, baseline).join('\n'), /安全要求收紧/);
    candidate.paths['/items'].get.security = [{ oauth: ['read'] }, { bearer: [] }];
    assert.deepEqual(findContractBreakingChanges(baseline, candidate), []);
    baseline.paths['/items'].get.security = [{ oauth: ['read', 'write'] }];
    candidate.paths['/items'].get.security = [{ oauth: ['read'] }];
    assert.deepEqual(findContractBreakingChanges(baseline, candidate), []);
    assert.match(findContractBreakingChanges(candidate, baseline).join('\n'), /安全要求收紧/);
    candidate.paths['/items'].get.security = [{ oauth: ['read'], bearer: [] }];
    assert.match(findContractBreakingChanges(baseline, candidate).join('\n'), /安全要求收紧/);
    candidate.paths['/items'].get.security = [];
    delete candidate.components.securitySchemes.bearer;
    assert.match(findContractBreakingChanges(baseline, candidate).join('\n'), /已有认证方式变化/);
  } catch (cause) {
    throw new Error('认证兼容方向回归失败', { cause });
  }
});

test('真实路由生成器stdout不改写提交产物，失败比较也保留原内容', () => {
  try {
    const root = resolve(import.meta.dirname, '../..');
    const artifactPath = join(root, 'packages/api-contract/openapi.json');
    const original = readFileSync(artifactPath, 'utf8');
    const generated = runOpenApiGenerator(root);
    const document = JSON.parse(generated);
    assert.equal(document.openapi, '3.0.3');
    assert.deepEqual(document.paths['/api/v1/fitness/catalog'].get.security, []);
    assert.deepEqual(document.paths['/api/v1/fitness/media/{media_id}'].get.security, []);
    assert.deepEqual(document.paths['/api/v1/profile/me'].get.security, [{ bearerAuth: [] }]);
    assert.equal(readFileSync(artifactPath, 'utf8'), original);
    assert.throws(() => checkCurrentContract(original, '{}', '1.0.0'), /契约校验失败/);
    assert.equal(readFileSync(artifactPath, 'utf8'), original);
  } catch (cause) {
    throw new Error('生成器只读输出回归失败', { cause });
  }
});
