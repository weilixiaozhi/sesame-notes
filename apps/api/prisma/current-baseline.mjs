import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDatabaseSetupTarget } from './database-target.mjs';
import { readCurrentSchemaSnapshot } from './schema-snapshot.mjs';

export { readCurrentSchemaSnapshot } from './schema-snapshot.mjs';
export const BASELINE_MIGRATION = '20261102000000_current_baseline';
export const CURRENT_HISTORY = Object.freeze(loadBaselineJson('./baseline-adoption-source.json'));
const expectedSchema = loadBaselineJson('./current-baseline-schema.json');
const migrationsDirectory = fileURLToPath(new URL('./migrations', import.meta.url));

/** 从完整部署包读取冻结资源，损坏或缺失时保留详细原因并阻止任何数据库写入。 */
function loadBaselineJson(name) {
  try {
    return JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
  } catch (cause) {
    throw new Error(`当前建库基线校验资源无法读取：${name}，请核对完整部署包`, { cause });
  }
}

/** 允许 Git 的行尾转换，任何 SQL 内容或注释差异仍使用不同的摘要。 */
function sqlChecksums(content) {
  try {
    const normalized = content.replaceAll('\r\n', '\n');
    return [...new Set([content, normalized, normalized.replaceAll('\n', '\r\n')])].map((value) =>
      createHash('sha256').update(value).digest('hex'),
    );
  } catch (cause) {
    throw new Error('数据库迁移文件摘要计算失败', { cause });
  }
}

/** 校验所有已完成记录对应的当前文件，未完成迁移必须由维护人员处理。 */
function verifyCurrentHistory(history) {
  try {
    if (history.some((row) => row.finished_at === null && row.rolled_back_at === null))
      throw new Error('存在未完成数据库迁移，请先核对失败日志，当前建库入口不会自动重试或跳过');
    const completed = history.filter((entry) => entry.finished_at !== null && entry.rolled_back_at === null);
    if (new Set(completed.map((entry) => entry.migration_name)).size !== completed.length)
      throw new Error('存在重复的成功数据库迁移记录，禁止跳过结构核验');
    const names = new Set(
      readdirSync(migrationsDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    );
    for (const row of history.filter((entry) => entry.finished_at !== null && entry.rolled_back_at === null)) {
      if (!names.has(row.migration_name)) throw new Error(`已应用迁移文件缺失：${row.migration_name}`);
      const content = readFileSync(join(migrationsDirectory, row.migration_name, 'migration.sql'), 'utf8');
      if (!sqlChecksums(content).includes(row.checksum))
        throw new Error(`已应用迁移校验和不匹配：${row.migration_name}`);
    }
  } catch (cause) {
    throw new Error('当前数据库迁移历史校验失败', { cause });
  }
}

/** 只认领完整当前版本的原迁移身份，未知记录、重复成功记录或失败现场均拒绝收敛。 */
function isAdoptableHistory(history) {
  try {
    const expected = new Map(CURRENT_HISTORY.map((entry) => [entry.name, entry.checksums]));
    const completed = history.filter((row) => row.finished_at !== null && row.rolled_back_at === null);
    return (
      completed.length === expected.size &&
      new Set(completed.map((row) => row.migration_name)).size === expected.size &&
      history.every(
        (row) =>
          expected.get(row.migration_name)?.includes(row.checksum) &&
          (row.finished_at !== null || row.rolled_back_at !== null),
      )
    );
  } catch (cause) {
    throw new Error('当前数据库原迁移身份校验失败', { cause });
  }
}

/** 比较完整语义结构，不使用数据库 OID、对象所有者或运行期序列值认领业务库。 */
function assertCurrentSchema(snapshot) {
  try {
    if (JSON.stringify(snapshot) === JSON.stringify(expectedSchema)) return;
    const expected = new Map(expectedSchema.map((entry) => [`${entry.kind}:${entry.name}`, entry.definition]));
    const actual = new Map(snapshot.map((entry) => [`${entry.kind}:${entry.name}`, entry.definition]));
    const changed = [...new Set([...expected.keys(), ...actual.keys()])].filter(
      (key) => expected.get(key) !== actual.get(key),
    );
    throw new Error(`数据库结构与当前基线不一致：${changed.slice(0, 12).join('、')}；共 ${changed.length} 项差异`);
  } catch (cause) {
    throw new Error('数据库必须已经具备完整当前结构；入口不会转换旧结构或修复业务数据', { cause });
  }
}

/** 当前协议的持久事实必须已经存在，不能用建库入口推测或推进存量库切点。 */
async function assertCurrentState(database) {
  try {
    const [state] = await database.$queryRaw`
      SELECT sync_cutover_cursor AS cursor, sync_cutover_at AS completed_at, sync_cursor_floor AS floor
      FROM public.server_epochs WHERE id=0
    `;
    if (
      !state ||
      typeof state.cursor !== 'bigint' ||
      state.cursor < 0n ||
      !(state.completed_at instanceof Date) ||
      !Number.isFinite(state.completed_at.getTime()) ||
      typeof state.floor !== 'bigint' ||
      state.floor < 0n
    )
      throw new Error('当前同步协议切点或持久水位未完成，禁止登记当前基线');
    const [required] = await database.$queryRaw`
      SELECT EXISTS(SELECT 1 FROM public.admin_groups WHERE id='a0000000-0000-4000-8000-000000000000'::uuid AND is_enabled AND deleted_at IS NULL) AS default_group,
        EXISTS(SELECT 1 FROM public.official_fitness_state WHERE id=1) AS fitness_state,
        EXISTS(SELECT 1 FROM public.product_analytics_state WHERE id=1) AS analytics_state
    `;
    if (!required?.default_group || !required.fitness_state || !required.analytics_state)
      throw new Error('当前数据库的默认组或目录、分析状态缺失，禁止登记当前基线');
  } catch (cause) {
    throw new Error('当前数据库持久状态校验失败', { cause });
  }
}

/** 迁移历史重登记要求独占停写窗口，不主动终止其他应用或运维连接。 */
async function requireExclusiveConnection(database) {
  try {
    await database.$executeRaw`SELECT pg_stat_clear_snapshot()`;
    const [activity] = await database.$queryRaw`
      SELECT count(*) AS clients FROM pg_stat_activity
      WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()
    `;
    if (!activity || activity.clients !== 0n)
      throw new Error('目标数据库仍有其他连接，请停止 API、后台任务并关闭数据库管理工具');
  } catch (cause) {
    throw new Error('当前基线登记需要独占停写窗口', { cause });
  }
}

/** 区分空库、已登记基线和完整当前库；存量路径只改 Prisma 元数据，不执行任何业务迁移 SQL。 */
export async function prepareCurrentBaseline(prisma) {
  try {
    return await prisma.$transaction(
      async (database) => {
        await assertDatabaseSetupTarget(database);
        const [table] = await database.$queryRaw`SELECT to_regclass('public._prisma_migrations')::text AS name`;
        const history = table?.name
          ? await database.$queryRaw`
        SELECT id,migration_name,checksum,finished_at,rolled_back_at,applied_steps_count FROM public._prisma_migrations ORDER BY started_at,id
      `
          : [];
        if (
          history.some(
            (row) =>
              row.migration_name === BASELINE_MIGRATION && row.finished_at !== null && row.rolled_back_at === null,
          )
        ) {
          verifyCurrentHistory(history);
          await assertCurrentState(database);
          // 只有基线时可直接核对冻结结构；后续已完成增量由其独立迁移文件和验收约束负责。
          if (history.filter((row) => row.finished_at !== null && row.rolled_back_at === null).length === 1)
            assertCurrentSchema(await readCurrentSchemaSnapshot(database));
          return { mode: 'current' };
        }
        const snapshot = await readCurrentSchemaSnapshot(database);
        if (
          history.length === 0 &&
          snapshot.every(
            (entry) =>
              entry.kind === 'extension' &&
              entry.name === 'uuid-ossp' &&
              JSON.parse(entry.definition).schema === 'public',
          )
        )
          return { mode: 'fresh' };
        if (!isAdoptableHistory(history))
          throw new Error('数据库不是已完成全部当前结构的已知版本，禁止重放建库 SQL或自动升级旧库');
        await requireExclusiveConnection(database);
        await database.$executeRaw`SELECT set_config('lock_timeout','5000',true)`;
        await database.$executeRaw`SELECT pg_advisory_xact_lock(1936028513,1)`;
        await database.$executeRaw`SELECT pg_advisory_xact_lock(1973108041::bigint)`;
        // 锁住已识别的业务表，阻止结构核验与元数据登记之间出现并发改写。
        const tables = snapshot.filter(
          (entry) => entry.kind === 'relation' && ['r', 'p'].includes(JSON.parse(entry.definition).kind),
        );
        const quoted = tables.map((entry) => `public."${entry.name.replaceAll('"', '""')}"`);
        if (quoted.length)
          await database.$executeRawUnsafe(`LOCK TABLE ${quoted.join(',')} IN SHARE ROW EXCLUSIVE MODE`);
        await database.$executeRaw`LOCK TABLE public._prisma_migrations IN ACCESS EXCLUSIVE MODE`;
        await requireExclusiveConnection(database);
        const lockedHistory = await database.$queryRaw`
        SELECT id,migration_name,checksum,finished_at,rolled_back_at,applied_steps_count FROM public._prisma_migrations ORDER BY started_at,id
      `;
        if (!isAdoptableHistory(lockedHistory)) throw new Error('结构核验期间迁移历史发生变化，未登记当前基线');
        assertCurrentSchema(await readCurrentSchemaSnapshot(database));
        await assertCurrentState(database);
        const baseline = readFileSync(join(migrationsDirectory, BASELINE_MIGRATION, 'migration.sql'), 'utf8');
        // 删除和新登记在同一事务内完成；任何故障均恢复原43项历史，业务表不会被写入。
        await database.$executeRaw`DELETE FROM public._prisma_migrations`;
        await database.$executeRaw`
        INSERT INTO public._prisma_migrations (id,checksum,finished_at,migration_name,logs,rolled_back_at,started_at,applied_steps_count)
        VALUES (${randomUUID()},${sqlChecksums(baseline)[0]},CURRENT_TIMESTAMP,${BASELINE_MIGRATION},NULL,NULL,CURRENT_TIMESTAMP,1)
      `;
        await requireExclusiveConnection(database);
        return { mode: 'adopted' };
      },
      { maxWait: 5_000, timeout: 120_000 },
    );
  } catch (cause) {
    throw new Error('当前数据库基线准备失败；未完成事务已回滚，请保持停写并核对详细日志', { cause });
  }
}
