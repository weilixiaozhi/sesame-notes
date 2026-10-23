import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const ADMIN_IDENTITY_MIGRATION = '20261009000000_admin_identity_groups';

const LEGACY_ROLE_GROUPS = { super_admin: '超级管理员', operator: '运营', auditor: '审计' };
const MISSING_PLAN_ERROR = '后台账号迁移缺少显式分配清单；请先运行受控迁移准备命令，核对每个账号的目标组和权限变化';

/** 保留旧角色的分组标签；普通账号业务权限由超级管理员配置，超管权限继续由身份提供。 */
export function legacyAdminIdentityPlan(accounts) {
  try {
    const groups = new Map();
    const usernames = new Set();
    const mapped = accounts.map((account) => {
      if (
        typeof account.username !== 'string' ||
        !/^[a-z][a-z0-9._-]{3,31}$/.test(account.username) ||
        usernames.has(account.username) ||
        !Object.hasOwn(LEGACY_ROLE_GROUPS, account.role)
      )
        throw new Error('旧后台账号或角色无法确定，请核对数据库；自动升级未改动账号和权限');
      usernames.add(account.username);
      if (!groups.has(account.role)) {
        groups.set(account.role, {
          id: randomUUID(),
          name: LEGACY_ROLE_GROUPS[account.role],
          description: '',
          sort: groups.size * 10,
          is_enabled: true,
          permissions: [],
          page_ids: [],
        });
      }
      return {
        username: account.username,
        group_id: groups.get(account.role).id,
        expected_role: account.role,
        permissions_reviewed: true,
      };
    });
    return { groups: [...groups.values()], accounts: mapped };
  } catch (cause) {
    throw new Error('后台账号自动升级清单生成失败', { cause });
  }
}

/** 只恢复已知身份迁移的完整回滚状态，不跳过迁移 SQL 或覆盖已有清单。 */
function canRetryRolledBackIdentityMigration(failures, state, hasPlan) {
  if (!failures.length) return false;
  try {
    const content = readFileSync(
      new URL(`./migrations/${ADMIN_IDENTITY_MIGRATION}/migration.sql`, import.meta.url),
      'utf8',
    );
    const normalized = content.replaceAll('\r\n', '\n');
    const checksums = new Set(
      [content, normalized, normalized.replaceAll('\n', '\r\n')].map((value) =>
        createHash('sha256').update(value).digest('hex'),
      ),
    );
    if (!state.legacy || state.groups || state.new_columns)
      throw new Error('后台身份迁移的数据库结构未完整回滚，自动升级不会重置失败记录');
    if (hasPlan) throw new Error('失败迁移已有分配清单，请核对原始错误；自动升级不会重置失败记录');
    if (failures.length !== 1) throw new Error('存在多条未完成迁移，自动升级不会重置失败记录');
    for (const failure of failures) {
      if (failure.migration_name !== ADMIN_IDENTITY_MIGRATION)
        throw new Error(`存在其他未完成迁移：${failure.migration_name}`);
      if (!checksums.has(failure.checksum)) throw new Error('失败的后台身份迁移与仓库 SQL 校验和不同');
      if (failure.applied_steps_count !== 0) throw new Error('失败的后台身份迁移已有执行步骤，请核对数据库状态');
      // Prisma 的事务失败记录可能未保存日志；此时只依据未执行步骤、完整回滚结构和缺失前置表重试。
      if (failure.logs !== null && (typeof failure.logs !== 'string' || !failure.logs.includes(MISSING_PLAN_ERROR)))
        throw new Error('后台身份迁移失败原因不是缺少分配清单，自动升级不会重置失败记录');
    }
    return true;
  } catch (cause) {
    throw new Error('后台身份迁移失败状态校验未通过', { cause });
  }
}

/** 只为尚未切换的旧账号准备完整清单，任何既有清单均交由历史迁移原样校验。 */
export async function prepareLegacyAdminIdentity(prisma) {
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1973108041::bigint)`;
        const [state] = await tx.$queryRaw`
          SELECT to_regclass('public.admin_accounts')::text AS accounts,
            to_regclass('public._prisma_migrations')::text AS migrations,
            to_regclass('public.admin_groups')::text AS groups,
            EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'admin_accounts' AND column_name = 'role'
            ) AS legacy,
            EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'admin_accounts'
                AND column_name IN (
                  'identity_type', 'group_id', 'version', 'created_by', 'updated_by', 'deleted_by', 'deleted_at'
                )
            ) AS new_columns
        `;
        if (!state?.accounts || !state.legacy) return { accounts: 0, retry: false };
        // 与身份迁移使用相同的安全锁和表锁，读取期间不能增删账号或更改角色。
        await tx.$executeRaw`LOCK TABLE public.admin_accounts IN ACCESS EXCLUSIVE MODE`;
        const failures = state.migrations
          ? await tx.$queryRaw`
              SELECT migration_name, checksum, logs, applied_steps_count FROM public._prisma_migrations
              WHERE finished_at IS NULL AND rolled_back_at IS NULL
            `
          : [];
        const [plan] = await tx.$queryRaw`
          SELECT to_regclass('public.admin_identity_migration_plan')::text AS name
        `;
        const retry = canRetryRolledBackIdentityMigration(failures, state, Boolean(plan?.name));
        if (retry) {
          // 未完成且没有日志的记录也可能属于运行中的迁移；独占连接证明没有其他迁移进程仍在处理它。
          const [activity] = await tx.$queryRaw`
            SELECT count(*) AS clients FROM pg_stat_activity
            WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()
          `;
          if (!activity || activity.clients !== 0n)
            throw new Error('目标数据库仍有其他连接，请停止相关服务后重试；未重置失败记录');
          // 先由部署入口恢复已回滚记录，再生成清单；两步之间中断时仍可安全重试。
          return { accounts: 0, retry: true };
        }
        if (plan?.name) return { accounts: 0, retry };
        const accounts = await tx.$queryRaw`
          SELECT username, role::text AS role FROM public.admin_accounts ORDER BY username
        `;
        if (!accounts.length) return { accounts: 0, retry };
        const payload = JSON.stringify(legacyAdminIdentityPlan(accounts));
        await tx.$executeRaw`
          CREATE TABLE public.admin_identity_migration_plan (
            id INTEGER PRIMARY KEY CHECK (id = 1), payload JSONB NOT NULL
          )
        `;
        await tx.$executeRaw`
          INSERT INTO public.admin_identity_migration_plan (id, payload) VALUES (1, ${payload}::jsonb)
        `;
        return { accounts: accounts.length, retry };
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
  } catch (cause) {
    throw new Error('后台账号自动升级准备失败，请查看原因并核对数据库状态', { cause });
  }
}
