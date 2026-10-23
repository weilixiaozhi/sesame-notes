BEGIN;
ALTER TABLE "product_analytics_events"
  ADD COLUMN "session_id" UUID,
  ADD COLUMN "flow_id" UUID;
CREATE INDEX "product_analytics_events_session_id_actor_key_occurred_at_idx"
  ON "product_analytics_events"("session_id","actor_key","occurred_at");
CREATE INDEX "product_analytics_events_flow_id_actor_key_occurred_at_idx"
  ON "product_analytics_events"("flow_id","actor_key","occurred_at");
ALTER TABLE "product_analytics_state"
  ADD COLUMN "association_started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "product_analytics_state" ALTER COLUMN "association_started_at" DROP DEFAULT;
COMMIT;
