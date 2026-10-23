BEGIN;

-- 与业务同步提交互斥，在同一事务中保存当前可证明的已提交水位。
SELECT pg_advisory_xact_lock(1936028513, 1);

ALTER TABLE "server_epochs"
  ADD COLUMN "sync_cursor_floor" BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT "server_epochs_sync_cursor_floor_check" CHECK ("sync_cursor_floor" >= 0);

-- 仅使用仍存在的事件和持久协议切点，不推测已经丢失的历史水位。
UPDATE "server_epochs"
SET "sync_cursor_floor" = GREATEST(
  COALESCE("sync_cutover_cursor", 0),
  COALESCE((SELECT MAX("change_id") FROM "sync_changes"), 0)
)
WHERE "id" = 0;

COMMIT;
