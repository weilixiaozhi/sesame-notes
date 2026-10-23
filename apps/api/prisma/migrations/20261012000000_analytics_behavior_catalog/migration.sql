BEGIN;

ALTER TABLE "product_analytics_events"
  ADD COLUMN "event_name" VARCHAR(128),
  DROP CONSTRAINT "product_analytics_kind_check",
  DROP CONSTRAINT "product_analytics_source_check",
  ADD CONSTRAINT "product_analytics_kind_check" CHECK ("kind" IN ('registration','active','page_view','action')),
  ADD CONSTRAINT "product_analytics_source_check" CHECK (
    ("kind"='registration' AND ("platform" IS NULL OR "platform" IN ('app','web'))
      AND "page_id" IS NULL AND "app_version" IS NULL AND "event_name" IS NULL) OR
    ("kind" IN ('active','page_view','action') AND "platform" IN ('app','web') AND "platform" IS NOT NULL
      AND ("page_id" IS NULL OR "page_id" ~ '^[a-z][a-z0-9_.-]{0,95}$')
      AND ("kind"='active' OR "page_id" IS NOT NULL)
      AND (("kind"='action' AND "event_name" IS NOT NULL AND "event_name" ~ '^[a-z][a-z0-9_]{0,127}$')
        OR ("kind"<>'action' AND "event_name" IS NULL)))
  );
CREATE INDEX "product_analytics_events_event_name_occurred_at_idx" ON "product_analytics_events"("event_name","occurred_at");
ALTER TABLE "product_analytics_state"
  ADD COLUMN "behavior_started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "product_analytics_state" ALTER COLUMN "behavior_started_at" DROP DEFAULT;

CREATE TABLE "analytics_categories" (
  "id" VARCHAR(64) PRIMARY KEY, "name" VARCHAR(80) NOT NULL UNIQUE, "description" VARCHAR(500) NOT NULL,
  "is_builtin" BOOLEAN NOT NULL DEFAULT FALSE, "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "analytics_category_text_check" CHECK (length(btrim("name")) > 0)
);
CREATE TABLE "analytics_definition_overrides" (
  "id" VARCHAR(160) PRIMARY KEY, "name" VARCHAR(80) NOT NULL, "category_id" VARCHAR(64) NOT NULL,
  "meaning" VARCHAR(500) NOT NULL, "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "analytics_definition_category_fk" FOREIGN KEY ("category_id") REFERENCES "analytics_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "analytics_definition_text_check" CHECK (length(btrim("name")) > 0 AND length(btrim("meaning")) > 0)
);
CREATE INDEX "analytics_definition_overrides_category_id_idx" ON "analytics_definition_overrides"("category_id");
INSERT INTO "analytics_categories" ("id","name","description","is_builtin") VALUES
  ('navigation','导航与首页','首页和主要业务模式切换',TRUE), ('accounting','记账','账本、交易、分类与记账统计',TRUE),
  ('fitness','训练','训练记录、计划、模板与训练执行',TRUE), ('memos','随记','随记本和随记内容',TRUE),
  ('credentials','密码','密码本和密码条目',TRUE), ('days','纪念日','纪念日分组和日期事件',TRUE),
  ('calendar','日历','日历浏览与关联记录',TRUE), ('settings','设置','个人资料、设备与应用偏好',TRUE);

ALTER TABLE "admin_groups" DROP CONSTRAINT "admin_groups_permissions_allowed", DROP CONSTRAINT "admin_groups_read_dependencies";
ALTER TABLE "admin_groups"
  ADD CONSTRAINT "admin_groups_permissions_allowed" CHECK (
    "permissions" <@ ARRAY['users:read','users:write','devices:read','devices:revoke','audit:read','status:read','analytics:read','analytics:manage','fitness:read','fitness:write']::TEXT[]),
  ADD CONSTRAINT "admin_groups_read_dependencies" CHECK (
    (NOT ('users:write'=ANY("permissions")) OR 'users:read'=ANY("permissions")) AND
    (NOT ('devices:read'=ANY("permissions")) OR 'users:read'=ANY("permissions")) AND
    (NOT ('devices:revoke'=ANY("permissions")) OR 'devices:read'=ANY("permissions")) AND
    (NOT ('users'=ANY("page_ids")) OR 'users:read'=ANY("permissions")) AND
    (NOT ('audit'=ANY("page_ids")) OR 'audit:read'=ANY("permissions")) AND
    (NOT ('analytics'=ANY("page_ids")) OR 'analytics:read'=ANY("permissions")) AND
    (NOT ('analytics:manage'=ANY("permissions")) OR 'analytics:read'=ANY("permissions")) AND
    (NOT ('fitness:write'=ANY("permissions")) OR 'fitness:read'=ANY("permissions")) AND
    (NOT ("page_ids" && ARRAY['fitness_exercises','fitness_templates','fitness_plans']::TEXT[]) OR 'fitness:read'=ANY("permissions"))
  );
COMMIT;
