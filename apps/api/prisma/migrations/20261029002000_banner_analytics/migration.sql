BEGIN;

ALTER TABLE "product_analytics_events"
  ADD COLUMN "banner_slot" VARCHAR(64),
  ADD COLUMN "banner_source" VARCHAR(16),
  ADD COLUMN "banner_version" INTEGER,
  ADD CONSTRAINT "product_analytics_banner_dimensions_check" CHECK (
    CASE WHEN "event_name" IN ('banner_impression', 'banner_click') THEN
      "kind" = 'action' AND "platform" = 'app'
      AND "banner_slot" IS NOT NULL AND "banner_source" IS NOT NULL AND "banner_version" IS NOT NULL
      AND (
        ("banner_slot" = 'fitness-plan-library' AND "page_id" = 'fitness.plans')
        OR ("banner_slot" = 'fitness-template-library' AND "page_id" = 'fitness.templates')
      )
      AND (
        ("banner_source" = 'builtin' AND "banner_version" = 0)
        OR ("banner_source" = 'remote' AND "banner_version" >= 1)
      )
    ELSE "banner_slot" IS NULL AND "banner_source" IS NULL AND "banner_version" IS NULL END
  );

CREATE INDEX "product_analytics_banner_dimension_time_idx"
  ON "product_analytics_events"("banner_slot", "banner_source", "banner_version", "occurred_at");

-- 单独记录 Banner 事件开始采集的时间，历史页面访问不能充当入口曝光或点击。
ALTER TABLE "product_analytics_state"
  ADD COLUMN "banner_started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

COMMIT;
