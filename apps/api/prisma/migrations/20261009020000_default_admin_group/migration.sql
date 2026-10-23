-- 系统默认组使用稳定引用，不依赖可修改的显示名称；现有非空归属原样保留。
BEGIN;
SELECT pg_advisory_xact_lock(1973108041::bigint);
LOCK TABLE "admin_accounts", "admin_groups" IN ACCESS EXCLUSIVE MODE;

DO $default_group$
DECLARE default_id UUID := 'a0000000-0000-4000-8000-000000000000'; group_name TEXT := '默认分组'; suffix INTEGER := 0;
BEGIN
  -- 固定引用被占用时必须由维护人员核对，不能把普通业务组直接变成系统默认组。
  IF EXISTS (SELECT 1 FROM "admin_groups" WHERE "id" = default_id) THEN
    RAISE EXCEPTION '系统默认分组的固定引用已被占用，请先核对现有用户组，不会覆盖其名称或权限';
  END IF;
  WHILE EXISTS (SELECT 1 FROM "admin_groups" WHERE "name" = group_name AND "deleted_at" IS NULL) LOOP
    suffix := suffix + 1;
    group_name := CASE WHEN suffix = 1 THEN '默认分组（系统）' ELSE '默认分组（系统 ' || suffix::TEXT || '）' END;
  END LOOP;
  INSERT INTO "admin_groups" ("id", "name", "description", "sort", "is_enabled", "permissions", "page_ids", "created_by", "updated_by")
  VALUES (default_id, group_name, '', -1000000, true, ARRAY[]::TEXT[], ARRAY[]::TEXT[], '系统迁移', '系统迁移');
END
$default_group$;

INSERT INTO "audit_logs" ("actor", "action", "target", "request_id", "metadata")
SELECT 'system', 'admin.account.default_group_assigned', jsonb_build_object('type','admin_account','id',a.id::TEXT),
       'migration:20261009020000', jsonb_build_object('username',a.username,'group_name',g.name)
FROM "admin_accounts" a CROSS JOIN "admin_groups" g
WHERE a."group_id" IS NULL AND g.id = 'a0000000-0000-4000-8000-000000000000'::UUID;
UPDATE "admin_sessions" SET "revoked_at" = CURRENT_TIMESTAMP
WHERE "revoked_at" IS NULL AND "admin_id" IN (SELECT "id" FROM "admin_accounts" WHERE "group_id" IS NULL);
UPDATE "admin_accounts"
SET "group_id" = 'a0000000-0000-4000-8000-000000000000'::UUID,
    "version" = "version" + 1, "updated_at" = CURRENT_TIMESTAMP, "updated_by" = '系统迁移'
WHERE "group_id" IS NULL;
ALTER TABLE "admin_accounts"
  ALTER COLUMN "group_id" SET DEFAULT 'a0000000-0000-4000-8000-000000000000'::UUID,
  ALTER COLUMN "group_id" SET NOT NULL;

-- 默认组始终可被新账号引用，禁止删除、停用或替换固定引用，仍允许修改名称和业务授权。
CREATE FUNCTION "protect_default_admin_group"() RETURNS TRIGGER LANGUAGE plpgsql AS $guard$
BEGIN
  IF OLD."id" = 'a0000000-0000-4000-8000-000000000000'::UUID THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION '系统默认分组不能删除' USING ERRCODE = '23514';
    END IF;
    IF NEW."id" <> OLD."id" OR NOT NEW."is_enabled" OR NEW."deleted_at" IS NOT NULL THEN
      RAISE EXCEPTION '系统默认分组不能停用、删除或变更固定引用' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER "admin_groups_protect_default" BEFORE UPDATE OR DELETE ON "admin_groups"
FOR EACH ROW EXECUTE FUNCTION "protect_default_admin_group"();
COMMIT;
