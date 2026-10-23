import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');

/** 发布拓扑必须显式限制单实例，并留出应用排空窗口。 */
test('生产 API 约束单实例并提供优雅退出时间', async () => {
  try {
    const compose = await readFile(join(root, 'deploy/docker-compose.prod.yml'), 'utf8');
    const api = compose.split('\n  api:')[1];
    assert.match(api, /container_name:\s*sesame-notes-prod-api\b/);
    assert.match(api, /stop_grace_period:\s*90s/);
  } catch (error) {
    throw new Error('单实例部署约束验证失败', { cause: error });
  }
});

test('prod 镜像仅复制部署白名单，test 编排显式选择 test 阶段', async () => {
  const dockerfile = await readFile(join(root, 'deploy/Dockerfile'), 'utf8');
  const testCompose = await readFile(join(root, 'deploy/docker-compose.test.yml'), 'utf8');
  const apiPackage = JSON.parse(await readFile(join(root, 'apps/api/package.json'), 'utf8'));
  assert.deepEqual(apiPackage.files, ['dist', 'prisma']);
  assert.ok(apiPackage.dependencies.prisma, '建库 CLI 必须可用于生产初始化');
  assert.match(dockerfile, /deploy --legacy --prod --ignore-scripts/);
  const frontendStage = dockerfile.split('AS frontend-build')[1]?.split('FROM frontend-build AS build')[0];
  assert.ok(frontendStage, '前端依赖阶段与 API 编译阶段必须独立');
  assert.doesNotMatch(frontendStage, /prisma\/build\/index\.js generate|typescript\/bin\/tsc/);
  assert.match(dockerfile, /FROM frontend-build AS build/);
  // 构建上下文继承宿主机 umask（077 时为 600）：镜像内必须补上读取权限，
  // 否则以 node 用户运行的 api/db-init 读不到建库脚本、迁移 SQL 与 tsc 复制的 JSON。
  assert.match(dockerfile, /find apps packages third_party -type f -exec chmod a\+r/);
  assert.match(dockerfile, /find apps packages third_party -type d -exec chmod a\+rx/);
  assert.match(dockerfile, /chmod a\+r LICENSE THIRD_PARTY_NOTICES\.txt/);
  assert.match(dockerfile, /^COPY LICENSE THIRD_PARTY_NOTICES\.txt \.\/$/m);
  assert.match(dockerfile, /^COPY third_party third_party$/m);
  assert.match(dockerfile, /COPY --from=build \/app\/apps\/api\/dist \/production\/dist/);
  const runtime = dockerfile.split('AS runtime')[1];
  assert.match(runtime, /COPY --from=production-files \/production \.\/apps\/api/);
  const runtimeCopies = runtime
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('COPY '));
  assert.deepEqual(runtimeCopies, [
    'COPY --from=production-files /production ./apps/api',
    'COPY --from=build /app/apps/web/public/fitness/videos ./apps/web/public/fitness/videos',
    'COPY --from=build /app/LICENSE /app/THIRD_PARTY_NOTICES.txt ./',
    'COPY --from=build /app/third_party ./third_party',
  ]);
  const dockerignore = await readFile(join(root, '.dockerignore'), 'utf8');
  assert.ok(
    dockerignore.indexOf('!third_party/exercises-dataset/NOTICE.md') > dockerignore.indexOf('*.md'),
    '上游 NOTICE 必须在通用 Markdown 排除规则之后重新纳入构建上下文',
  );
  assert.doesNotMatch(runtime, /\.\/packages/);
  assert.match(testCompose, /target: test/);
});

test('生产编排包含 首版初始化闸门、可写数据目录准备且不依赖项目内 Caddy', async () => {
  const compose = await readFile(join(root, 'deploy/docker-compose.prod.yml'), 'utf8');
  const dockerfile = await readFile(join(root, 'deploy/Dockerfile'), 'utf8');

  assert.match(compose, /^\s{2}db-init:/m);
  assert.match(compose, /condition:\s*service_completed_successfully/);
  // TLS/反代由宿主机统一管理：编排不得包含 caddy 服务/卷/Caddyfile/DOMAIN，
  // API 只暴露宿主机本机端口供其转发
  assert.doesNotMatch(compose, /^\s{2}caddy:/m);
  assert.doesNotMatch(compose, /caddy_data|caddy_config|Caddyfile|DOMAIN/);
  assert.match(compose, /127\.0\.0\.1:8080:8080/);
  assert.match(dockerfile, /mkdir\s+-p\s+\/data/);
  assert.match(dockerfile, /chown\s+node:node\s+\/data/);
});

test('生产 healthcheck 使用 DB-aware readiness 端点', async () => {
  const compose = await readFile(join(root, 'deploy/docker-compose.prod.yml'), 'utf8');

  // 容器健康判定必须探测数据库可用性（readiness），进程级 liveness 不足以证明服务可导流
  assert.match(compose, /wget[^\n]*api\/v1\/health\/ready/);
});

test('生产和本地共用迁移入口，按仓库提交的迁移历史升级数据库', async () => {
  const compose = await readFile(join(root, 'deploy/docker-compose.prod.yml'), 'utf8');
  const apiPackage = JSON.parse(await readFile(join(root, 'apps/api/package.json'), 'utf8'));
  const setup = await readFile(join(root, 'apps/api/prisma/setup.mjs'), 'utf8');
  assert.match(compose, /command: \['node', 'apps\/api\/prisma\/setup\.mjs'\]/);
  assert.match(apiPackage.scripts['db:setup'], /prisma\/setup\.mjs$/);
  assert.doesNotMatch(apiPackage.scripts['db:setup'], /--env-file/);
  assert.match(apiPackage.scripts['db:setup:test'], /--env-file=\.\.\/\.\.\/\.env\.test/);
  assert.match(apiPackage.scripts['db:setup:test'], /--test-admin$/);
  assert.doesNotMatch(compose + apiPackage.scripts['db:setup'], /--test-admin/);
  assert.match(apiPackage.scripts['test:serve'], /--env-file=\.\.\/\.\.\/\.env\.test/);
  // 已应用迁移不可修改，结构变更只能新增迁移，因此入口必须是 migrate deploy。
  assert.match(setup, /'migrate', 'deploy'/);
  assert.match(apiPackage.scripts['db:migrate:dev'], /migrate dev/);
  assert.doesNotMatch(
    compose + apiPackage.scripts['db:setup'] + setup,
    /db push|accept-data-loss|force-reset|migrate reset/,
  );

  const migrationsDirectory = join(root, 'apps/api/prisma/migrations');
  assert.match(await readFile(join(migrationsDirectory, 'migration_lock.toml'), 'utf8'), /provider = "postgresql"/);
  const migrations = (await readdir(migrationsDirectory)).filter((entry) => entry !== 'migration_lock.toml');
  assert.ok(migrations.length >= 1, '迁移历史必须至少包含一个迁移');
  // 基线迁移必须同时包含建表结构与 Prisma datamodel 无法表达的不变量。
  const baseline = await readFile(join(migrationsDirectory, migrations.sort()[0], 'migration.sql'), 'utf8');
  assert.match(baseline, /CREATE TABLE "users"/);
  assert.match(baseline, /CREATE FUNCTION public\.fitness_payload_valid/);
});

test('test 仅绑定停写迁移后的明确环境卷，缺失不能自动创建空卷', async () => {
  const compose = await readFile(join(root, 'deploy/docker-compose.test.yml'), 'utf8');
  assert.match(compose, /^name: sesame-notes-test$/m);
  assert.match(compose, /pg_data:\s+external: true\s+name: sesame-notes-test_pg_data/);
  assert.match(compose, /api_data:\s+external: true\s+name: sesame-notes-test_api_data/);
  assert.match(compose, /- pg_data:\/var\/lib\/postgresql\/data/);
  assert.match(compose, /- api_data:\/data/);
  assert.match(compose, /container_name: sesame-notes-test-api/);
  assert.match(compose, /image: sesame-notes-test-api:test-\$\{TEST_IMAGE_TAG:-local\}/);
  assert.match(compose, /image: sesame-notes-test-postgres:test-17-\$\{POSTGRES_IMAGE_REVISION:\?/);
  assert.equal(compose.match(/pull_policy: never/g)?.length, 2);
  assert.match(compose, /POSTGRES_DB: sesame_notes_test/);
  assert.match(compose, /postgres:5432\/sesame_notes_test/);
  assert.match(compose, /SESAME_ENV: test/);
  assert.match(compose, /setup\.mjs --test-admin && exec node/);
  assert.match(compose, /name: sesame-notes-test_default/);
  assert.equal(compose.match(/type: bind/g)?.length, 2);
  assert.equal(compose.match(/create_host_path: false/g)?.length, 2);
  for (const directory of ['src', 'prisma']) {
    assert.match(compose, new RegExp(`source: \\$\\{TEST_SOURCE_ROOT:-\\.\\.\\}/apps/api/${directory}`));
    assert.ok(compose.includes(`target: /app/apps/api/${directory}`));
  }
  assert.match(compose, /CORS_ORIGINS: \$\{CORS_ORIGINS:-\}/);
  assert.match(await readFile(join(root, '.env.test.example'), 'utf8'), /^TEST_SOURCE_ROOT=\.\.$/m);
  assert.doesNotMatch(compose, /sesame-notes_dev_|sesame-notes_postgres_data|target: development/);
  assert.match(compose, /127\.0\.0\.1:55432:5432/);
  assert.match(compose, /0\.0\.0\.0:8080:8080/);
});

test('prod 保留原物理卷，容器、数据库、镜像与网络明确环境身份', async () => {
  const compose = await readFile(join(root, 'deploy/docker-compose.prod.yml'), 'utf8');
  assert.match(compose, /^name: sesame-notes-prod$/m);
  assert.match(compose, /^ {4}container_name: sesame-notes-prod-api$/m);
  assert.match(compose, /pg_data:\s+external: true\s+name: sesame-notes-prod_pg_data/);
  assert.match(compose, /api_data:\s+external: true\s+name: sesame-notes-prod_api_data/);
  assert.equal(compose.match(/image: sesame-notes-prod-api:prod-\$\{PROD_IMAGE_TAG:\?/g)?.length, 2);
  assert.match(compose, /image: sesame-notes-prod-postgres:prod-17-\$\{POSTGRES_IMAGE_REVISION:\?/);
  assert.equal(compose.match(/pull_policy: never/g)?.length, 3);
  assert.match(compose, /POSTGRES_DB: sesame_notes_prod/);
  assert.match(compose, /pg_isready -U sesame -d sesame_notes_prod/);
  assert.match(compose, /SESAME_ENV: prod/);
  assert.match(compose, /name: sesame-notes-prod_default/);
  assert.doesNotMatch(compose, /sesame-notes-api:|PROD_IMAGE_TAG:-local|image: postgres:17-alpine/);
  assert.match(compose, /127\.0\.0\.1:8080:8080/);
});
