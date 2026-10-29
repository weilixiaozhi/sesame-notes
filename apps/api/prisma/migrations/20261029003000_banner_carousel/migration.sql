BEGIN;

ALTER TABLE "app_banners"
  ADD COLUMN "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN "target_id" VARCHAR(128),
  ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deleted_at" TIMESTAMPTZ(3);

-- 每条已保存的自定义图片取得稳定身份，图片引用和版本保持不变。
UPDATE "app_banners" SET "deleted_at" = "updated_at" WHERE NOT "is_enabled";

ALTER TABLE "app_banners"
  DROP CONSTRAINT "app_banners_pkey",
  DROP CONSTRAINT "app_banners_target_check",
  ADD CONSTRAINT "app_banners_pkey" PRIMARY KEY ("id"),
  ADD CONSTRAINT "app_banners_sort_order_check" CHECK ("sort_order" BETWEEN 0 AND 9999),
  ADD CONSTRAINT "app_banners_deleted_disabled_check" CHECK ("deleted_at" IS NULL OR NOT "is_enabled"),
  ADD CONSTRAINT "app_banners_enabled_image_check" CHECK (NOT "is_enabled" OR "image_id" IS NOT NULL),
  ADD CONSTRAINT "app_banners_target_check" CHECK (
    ("target" IN ('fitness-plan-library', 'fitness-template-library', 'fitness-exercises', 'fitness-plans', 'fitness-templates')
      AND "target_id" IS NULL)
    OR ("target" IN ('official-plan', 'official-template') AND "target_id" IS NOT NULL AND length(btrim("target_id")) > 0)
  );

CREATE INDEX "app_banners_slot_display_idx"
  ON "app_banners"("slot", "deleted_at", "is_enabled", "sort_order", "id");

ALTER TABLE "product_analytics_events"
  ADD COLUMN "banner_id" VARCHAR(96),
  ADD CONSTRAINT "product_analytics_banner_slide_check" CHECK (
    "banner_id" IS NULL OR (
      "event_name" IN ('banner_impression', 'banner_click')
      AND "banner_source" IS NOT NULL AND "banner_slot" IS NOT NULL
      AND (
        ("banner_source" = 'builtin' AND "banner_id" = 'builtin:' || "banner_slot")
        OR ("banner_source" = 'remote' AND "banner_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      )
    )
  );

CREATE INDEX "product_analytics_banner_slide_time_idx"
  ON "product_analytics_events"("banner_id", "banner_slot", "banner_source", "banner_version", "occurred_at");

-- 每张图片的统计使用完整身份维度；历史无图片身份的事件保留但不推断归属。
UPDATE "product_analytics_state" SET "banner_started_at" = CURRENT_TIMESTAMP;

COMMIT;
