BEGIN;

ALTER TABLE "product_analytics_state"
  DROP COLUMN "registration_platform_started_at",
  DROP COLUMN "behavior_started_at",
  DROP COLUMN "association_started_at";

COMMIT;
