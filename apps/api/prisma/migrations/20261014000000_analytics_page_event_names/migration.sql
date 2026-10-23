BEGIN;

ALTER TABLE "product_analytics_events" DROP CONSTRAINT "product_analytics_source_check";

-- 访问事实必须具有规范事件身份，缺少身份的记录不能参与事件统计。
DELETE FROM "product_analytics_events"
WHERE "kind" = 'page_view'
  AND "event_name" IS DISTINCT FROM replace("page_id", '.', '_') || '_view';

ALTER TABLE "product_analytics_events"
  ADD CONSTRAINT "product_analytics_source_check" CHECK (
    ("kind" = 'registration' AND ("platform" IS NULL OR "platform" IN ('app', 'web'))
      AND "page_id" IS NULL AND "app_version" IS NULL AND "event_name" IS NULL) OR
    ("kind" IN ('active', 'page_view', 'action') AND "platform" IN ('app', 'web') AND "platform" IS NOT NULL
      AND ("page_id" IS NULL OR "page_id" ~ '^[a-z][a-z0-9_.-]{0,95}$')
      AND ("kind" = 'active' OR "page_id" IS NOT NULL)
      AND (
        ("kind" = 'active' AND "event_name" IS NULL) OR
        ("kind" IN ('page_view', 'action') AND "event_name" IS NOT NULL
          AND "event_name" ~ '^[a-z][a-z0-9_]{0,127}$'
          AND ("kind" <> 'page_view' OR "event_name" = replace("page_id", '.', '_') || '_view'))
      ))
  );

COMMIT;
