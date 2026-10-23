BEGIN;

-- 所有已保存正文必须与客户端当前可见内容一致，存在待处理内容时保留原表并中止迁移。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "official_fitness_content"
    WHERE "published" IS NULL
      OR "draft" IS DISTINCT FROM "published"
      OR "is_enabled" IS DISTINCT FROM "published_enabled"
  ) THEN
    RAISE EXCEPTION '官方健身内容存在尚未发布的修改，请明确处理后再执行迁移';
  END IF;
END $$;

ALTER TABLE "official_fitness_content"
  DROP CONSTRAINT "official_fitness_content_draft_check",
  DROP CONSTRAINT "official_fitness_content_publication_check";
ALTER TABLE "official_fitness_content" RENAME COLUMN "draft" TO "content";
ALTER TABLE "official_fitness_content"
  DROP COLUMN "published",
  DROP COLUMN "published_enabled",
  DROP COLUMN "published_at",
  ADD CONSTRAINT "official_fitness_content_content_check" CHECK (
    jsonb_typeof("content") = 'object'
    AND "content"->>'id' IS NOT NULL
    AND "content"->>'id' = "id"
  );

ALTER TABLE "admin_groups"
  DROP CONSTRAINT "admin_groups_permissions_allowed",
  DROP CONSTRAINT "admin_groups_read_dependencies";
UPDATE "admin_groups"
SET "permissions" = array_remove("permissions", 'fitness:publish'),
    "version" = "version" + 1,
    "updated_at" = CURRENT_TIMESTAMP
WHERE 'fitness:publish' = ANY("permissions");
ALTER TABLE "admin_groups"
  ADD CONSTRAINT "admin_groups_permissions_allowed" CHECK (
    "permissions" <@ ARRAY[
      'users:read','users:write','devices:read','devices:revoke','audit:read','status:read',
      'analytics:read','fitness:read','fitness:write'
    ]::TEXT[]
  ),
  ADD CONSTRAINT "admin_groups_read_dependencies" CHECK (
    (NOT ('users:write'=ANY("permissions")) OR 'users:read'=ANY("permissions")) AND
    (NOT ('devices:read'=ANY("permissions")) OR 'users:read'=ANY("permissions")) AND
    (NOT ('devices:revoke'=ANY("permissions")) OR 'devices:read'=ANY("permissions")) AND
    (NOT ('users'=ANY("page_ids")) OR 'users:read'=ANY("permissions")) AND
    (NOT ('audit'=ANY("page_ids")) OR 'audit:read'=ANY("permissions")) AND
    (NOT ('analytics'=ANY("page_ids")) OR 'analytics:read'=ANY("permissions")) AND
    (NOT ('fitness:write'=ANY("permissions")) OR 'fitness:read'=ANY("permissions")) AND
    (NOT ("page_ids" && ARRAY['fitness_exercises','fitness_templates','fitness_plans']::TEXT[]) OR 'fitness:read'=ANY("permissions"))
  );

COMMIT;
