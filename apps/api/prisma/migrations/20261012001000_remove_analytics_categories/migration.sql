BEGIN;

DROP TABLE "analytics_definition_overrides";
DROP TABLE "analytics_categories";

ALTER TABLE "admin_groups"
  DROP CONSTRAINT "admin_groups_permissions_allowed",
  DROP CONSTRAINT "admin_groups_read_dependencies";
UPDATE "admin_groups"
SET "permissions" = array_remove("permissions", 'analytics:manage'),
    "version" = "version" + 1,
    "updated_at" = CURRENT_TIMESTAMP
WHERE 'analytics:manage' = ANY("permissions");
ALTER TABLE "admin_groups"
  ADD CONSTRAINT "admin_groups_permissions_allowed" CHECK (
    "permissions" <@ ARRAY['users:read','users:write','devices:read','devices:revoke','audit:read','status:read','analytics:read','fitness:read','fitness:write']::TEXT[]
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
