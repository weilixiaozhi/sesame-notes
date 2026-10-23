BEGIN;
CREATE TABLE "product_analytics_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "actor_key" CHAR(64) NOT NULL,
  "event_id" UUID NOT NULL, "kind" VARCHAR(24) NOT NULL,
  "occurred_at" TIMESTAMPTZ(3) NOT NULL, "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "platform" VARCHAR(8), "page_id" VARCHAR(96), "app_version" VARCHAR(64),
  CONSTRAINT "product_analytics_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "product_analytics_kind_check" CHECK ("kind" IN ('registration','active','page_view')),
  CONSTRAINT "product_analytics_actor_check" CHECK ("actor_key" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "product_analytics_source_check" CHECK (
    ("kind"='registration' AND "platform" IS NULL AND "page_id" IS NULL AND "app_version" IS NULL) OR
    ("kind" IN ('active','page_view') AND "platform" IS NOT NULL AND "platform" IN ('app','web') AND
      ("page_id" IS NULL OR "page_id" ~ '^[a-z][a-z0-9_.-]{0,95}$') AND
      ("kind" <> 'page_view' OR "page_id" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "product_analytics_events_actor_key_event_id_key" ON "product_analytics_events"("actor_key","event_id");
CREATE INDEX "product_analytics_events_occurred_at_kind_idx" ON "product_analytics_events"("occurred_at","kind");
CREATE INDEX "product_analytics_events_actor_key_occurred_at_idx" ON "product_analytics_events"("actor_key","occurred_at");
CREATE TABLE "product_analytics_state" (
  "id" INTEGER NOT NULL, "started_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "product_analytics_state_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "product_analytics_state_singleton" CHECK ("id"=1)
);
INSERT INTO "product_analytics_state" ("id","started_at") VALUES (1,CURRENT_TIMESTAMP);
-- 注册事件与账号写入在同一事务完成，注销账号不移除已经发生的注册事实。
CREATE FUNCTION "record_product_registration"() RETURNS TRIGGER LANGUAGE plpgsql AS $registration$
BEGIN
  INSERT INTO "product_analytics_events" ("actor_key","event_id","kind","occurred_at")
  VALUES (encode(sha256(convert_to('sesame-analytics-user:' || NEW.id::TEXT,'UTF8')),'hex'),NEW.id,'registration',NEW.created_at)
  ON CONFLICT ("actor_key","event_id") DO NOTHING;
  RETURN NEW;
END;
$registration$;
CREATE TRIGGER "users_record_product_registration" AFTER INSERT ON "users" FOR EACH ROW EXECUTE FUNCTION "record_product_registration"();
-- 仅回填仍有确切注册时间的账号，采集起点标记历史资料不完整。
INSERT INTO "product_analytics_events" ("actor_key","event_id","kind","occurred_at")
SELECT encode(sha256(convert_to('sesame-analytics-user:' || "id"::TEXT,'UTF8')),'hex'),"id",'registration',"created_at" FROM "users"
ON CONFLICT ("actor_key","event_id") DO NOTHING;
COMMIT;
