-- 后台身份、单组授权与软删除在同一事务切换；存量账号必须具备显式分配清单。
BEGIN;
SELECT pg_advisory_xact_lock(1973108041::bigint);
LOCK TABLE "admin_accounts" IN ACCESS EXCLUSIVE MODE;

CREATE TABLE "admin_groups" (
  "id" UUID NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "description" VARCHAR(500) NOT NULL DEFAULT '',
  "sort" INTEGER NOT NULL DEFAULT 0,
  "is_enabled" BOOLEAN NOT NULL DEFAULT true,
  "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "page_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" VARCHAR(100), "updated_by" VARCHAR(100), "deleted_by" VARCHAR(100), "deleted_at" TIMESTAMPTZ(3),
  CONSTRAINT "admin_groups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_groups_version_positive" CHECK ("version" > 0),
  CONSTRAINT "admin_groups_name_nonempty" CHECK (length(btrim("name")) > 0),
  CONSTRAINT "admin_groups_deleted_disabled" CHECK ("deleted_at" IS NULL OR NOT "is_enabled"),
  CONSTRAINT "admin_groups_permissions_allowed" CHECK ("permissions" <@ ARRAY['users:read','users:write','devices:read','devices:revoke','audit:read','status:read']::TEXT[]),
  CONSTRAINT "admin_groups_pages_allowed" CHECK ("page_ids" <@ ARRAY['users','audit']::TEXT[]),
  CONSTRAINT "admin_groups_read_dependencies" CHECK (
    (NOT ('users:write' = ANY("permissions")) OR 'users:read' = ANY("permissions")) AND
    (NOT ('devices:read' = ANY("permissions")) OR 'users:read' = ANY("permissions")) AND
    (NOT ('devices:revoke' = ANY("permissions")) OR 'devices:read' = ANY("permissions")) AND
    (NOT ('users' = ANY("page_ids")) OR 'users:read' = ANY("permissions")) AND
    (NOT ('audit' = ANY("page_ids")) OR 'audit:read' = ANY("permissions"))
  )
);
CREATE UNIQUE INDEX "admin_groups_live_name_key" ON "admin_groups" ("name") WHERE "deleted_at" IS NULL;
CREATE INDEX "admin_groups_deleted_at_sort_idx" ON "admin_groups" ("deleted_at", "sort");
ALTER TABLE "admin_accounts"
  ADD COLUMN "identity_type" VARCHAR(32) NOT NULL DEFAULT 'standard_user',
  ADD COLUMN "group_id" UUID,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "created_by" VARCHAR(100), ADD COLUMN "updated_by" VARCHAR(100),
  ADD COLUMN "deleted_by" VARCHAR(100), ADD COLUMN "deleted_at" TIMESTAMPTZ(3);

DO $migration$
DECLARE plan JSONB; mapped_count INTEGER; account_count INTEGER;
BEGIN
  SELECT count(*) INTO account_count FROM "admin_accounts";
  IF to_regclass('public.admin_identity_migration_plan') IS NOT NULL THEN
    EXECUTE 'SELECT payload FROM public.admin_identity_migration_plan WHERE id = 1' INTO plan;
  END IF;
  IF account_count > 0 AND plan IS NULL THEN
    RAISE EXCEPTION '后台账号迁移缺少显式分配清单；请先运行受控迁移准备命令，核对每个账号的目标组和权限变化';
  END IF;
  IF plan IS NOT NULL THEN
    IF jsonb_typeof(plan->'groups') IS DISTINCT FROM 'array' OR jsonb_typeof(plan->'accounts') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION '后台账号迁移清单结构无效';
    END IF;
    INSERT INTO "admin_groups" ("id", "name", "description", "sort", "is_enabled", "permissions", "page_ids", "created_by", "updated_by")
    SELECT g.id, g.name, COALESCE(g.description, ''), COALESCE(g.sort, 0), g.is_enabled, g.permissions, g.page_ids, '系统迁移', '系统迁移'
      FROM jsonb_to_recordset(plan->'groups') AS g(id UUID, name TEXT, description TEXT, sort INTEGER, is_enabled BOOLEAN, permissions TEXT[], page_ids TEXT[]);
    -- 数量、账号名、旧身份和权限评审必须全部匹配，避免漏分配或静默替换状态。
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(plan->'accounts') AS m(username TEXT, group_id UUID, expected_role TEXT, permissions_reviewed BOOLEAN)
      LEFT JOIN "admin_accounts" a ON a.username = m.username
      LEFT JOIN "admin_groups" g ON g.id = m.group_id
      WHERE a.id IS NULL OR g.id IS NULL OR a.role::TEXT IS DISTINCT FROM m.expected_role OR m.permissions_reviewed IS DISTINCT FROM true
    ) OR (SELECT count(DISTINCT m->>'username') FROM jsonb_array_elements(plan->'accounts') m) <> jsonb_array_length(plan->'accounts') THEN
      RAISE EXCEPTION '后台账号迁移清单存在重复、未知账号、目标组无效、旧身份变化或尚未评审的权限配置';
    END IF;
    UPDATE "admin_accounts" a SET group_id = m.group_id
      FROM jsonb_to_recordset(plan->'accounts') AS m(username TEXT, group_id UUID) WHERE a.username = m.username;
    GET DIAGNOSTICS mapped_count = ROW_COUNT;
    IF mapped_count <> account_count OR jsonb_array_length(plan->'accounts') <> account_count THEN
      RAISE EXCEPTION '后台账号迁移清单未完整覆盖全部存量账号';
    END IF;
  ELSE
    -- 空数据库提供可修改、可删除的示例组，初始不授予任何业务权限。
    INSERT INTO "admin_groups" ("id", "name", "sort", "created_by", "updated_by") VALUES
      ('a0000000-0000-4000-8000-000000000001', '运营', 10, '系统初始化', '系统初始化'),
      ('a0000000-0000-4000-8000-000000000002', '产品', 20, '系统初始化', '系统初始化'),
      ('a0000000-0000-4000-8000-000000000003', '开发', 30, '系统初始化', '系统初始化'),
      ('a0000000-0000-4000-8000-000000000004', '测试', 40, '系统初始化', '系统初始化');
  END IF;
END
$migration$;

INSERT INTO "audit_logs" ("actor", "action", "target", "request_id", "metadata")
SELECT 'system', 'admin.identity_migrated', jsonb_build_object('type','admin_account','id', a.id::TEXT), 'migration:20261009000000',
  jsonb_build_object('previous_role', a.role::TEXT, 'identity_type', CASE WHEN a.role::TEXT = 'super_admin' THEN 'super_admin' ELSE 'standard_user' END, 'group_name', g.name)
FROM "admin_accounts" a JOIN "admin_groups" g ON g.id = a.group_id;
UPDATE "admin_accounts" SET "identity_type" = CASE WHEN "role"::TEXT = 'super_admin' THEN 'super_admin' ELSE 'standard_user' END;
UPDATE "admin_sessions" SET "revoked_at" = CURRENT_TIMESTAMP WHERE "revoked_at" IS NULL;
DROP INDEX "admin_accounts_role_is_enabled_idx";
ALTER TABLE "admin_accounts" DROP COLUMN "role", DROP COLUMN "must_change_password", ALTER COLUMN "group_id" SET NOT NULL;
DROP TYPE "AdminRole";
ALTER TABLE "admin_accounts"
  ADD CONSTRAINT "admin_accounts_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "admin_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "admin_accounts_identity_type_known" CHECK ("identity_type" IN ('super_admin','standard_user')),
  ADD CONSTRAINT "admin_accounts_version_positive" CHECK ("version" > 0),
  ADD CONSTRAINT "admin_accounts_deleted_disabled" CHECK ("deleted_at" IS NULL OR NOT "is_enabled");
CREATE INDEX "admin_accounts_identity_type_is_enabled_deleted_at_idx" ON "admin_accounts"("identity_type", "is_enabled", "deleted_at");
CREATE INDEX "admin_accounts_group_id_deleted_at_idx" ON "admin_accounts"("group_id", "deleted_at");
DROP TABLE IF EXISTS "admin_identity_migration_plan";
COMMIT;
