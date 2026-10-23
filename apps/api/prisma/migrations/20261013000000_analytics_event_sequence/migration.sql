BEGIN;

ALTER TABLE "product_analytics_events" ADD COLUMN "event_sequence" INTEGER;

COMMIT;
