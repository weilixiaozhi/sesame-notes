BEGIN;

-- 注册来源由注册入口在同一事务内写入；来源未知的历史记录仍只计入全部统计。
ALTER TABLE "product_analytics_events"
  DROP CONSTRAINT "product_analytics_source_check",
  ADD CONSTRAINT "product_analytics_source_check" CHECK (
    ("kind" = 'registration' AND ("platform" IS NULL OR "platform" IN ('app', 'web'))
      AND "page_id" IS NULL AND "app_version" IS NULL) OR
    ("kind" IN ('active', 'page_view') AND "platform" IS NOT NULL AND "platform" IN ('app', 'web')
      AND ("page_id" IS NULL OR "page_id" ~ '^[a-z][a-z0-9_.-]{0,95}$')
      AND ("kind" <> 'page_view' OR "page_id" IS NOT NULL))
  );

ALTER TABLE "product_analytics_state"
  ADD COLUMN "registration_platform_started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "product_analytics_state" ALTER COLUMN "registration_platform_started_at" DROP DEFAULT;

CREATE INDEX "product_analytics_events_platform_occurred_at_kind_idx"
  ON "product_analytics_events"("platform", "occurred_at", "kind");

COMMIT;
