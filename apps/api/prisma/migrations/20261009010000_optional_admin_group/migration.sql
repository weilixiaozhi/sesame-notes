-- 后台用户可暂不归组；已有归属与外键保护保持有效。
BEGIN;
SELECT pg_advisory_xact_lock(1973108041::bigint);
ALTER TABLE "admin_accounts" ALTER COLUMN "group_id" DROP NOT NULL;
COMMIT;
