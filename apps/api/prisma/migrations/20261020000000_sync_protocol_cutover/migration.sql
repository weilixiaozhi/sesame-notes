BEGIN;

ALTER TABLE "server_epochs"
  ADD COLUMN "sync_cutover_cursor" BIGINT,
  ADD COLUMN "sync_cutover_at" TIMESTAMPTZ(3),
  ADD CONSTRAINT "server_epochs_sync_cutover_check" CHECK (
    ("sync_cutover_cursor" IS NULL AND "sync_cutover_at" IS NULL)
    OR ("sync_cutover_cursor" IS NOT NULL AND "sync_cutover_cursor" >= 0 AND "sync_cutover_at" IS NOT NULL)
  );

-- 全新空库没有历史客户端事实；存量库必须使用停写工具显式确认切点。
UPDATE "server_epochs"
SET "sync_cutover_cursor" = 0, "sync_cutover_at" = CURRENT_TIMESTAMP
WHERE "id" = 0
  AND NOT EXISTS (SELECT 1 FROM "users")
  AND NOT EXISTS (SELECT 1 FROM "sync_changes");

INSERT INTO "audit_logs" ("actor", "action", "target", "request_id", "metadata")
SELECT 'system', 'sync.protocol_cutover',
       jsonb_build_object('type', 'database', 'id', current_database()),
       'migration:sync-protocol-cutover',
       jsonb_build_object('mode', 'fresh_database', 'original_cursor', '0', 'result_cursor', '0')
FROM "server_epochs"
WHERE "id" = 0 AND "sync_cutover_cursor" = 0;

COMMIT;
