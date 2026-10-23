-- 独立后台身份：保留 users 主键、凭据与全部业务外键，不自动复制或提升账号。
-- 在维护窗口关闭旧后台入口，执行此迁移，再用新版本的 db:seed 初始化首个管理员。
BEGIN;

CREATE TYPE "AdminRole" AS ENUM ('super_admin', 'operator', 'auditor');

CREATE TABLE "admin_accounts" (
    "id" UUID NOT NULL,
    "username" VARCHAR(32) NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "role" "AdminRole" NOT NULL DEFAULT 'auditor',
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "must_change_password" BOOLEAN NOT NULL DEFAULT true,
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "admin_accounts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admin_accounts_username_normalized" CHECK ("username" ~ '^[a-z][a-z0-9._-]{3,31}$'),
    CONSTRAINT "admin_accounts_failed_attempts_nonnegative" CHECK ("failed_login_attempts" >= 0)
);

CREATE TABLE "admin_sessions" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(512),
    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_accounts_username_key" ON "admin_accounts"("username");
CREATE INDEX "admin_accounts_role_is_enabled_idx" ON "admin_accounts"("role", "is_enabled");
CREATE UNIQUE INDEX "admin_sessions_token_hash_key" ON "admin_sessions"("token_hash");
CREATE INDEX "admin_sessions_admin_id_revoked_at_idx" ON "admin_sessions"("admin_id", "revoked_at");
CREATE INDEX "admin_sessions_expires_at_idx" ON "admin_sessions"("expires_at");
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_id_fkey"
    FOREIGN KEY ("admin_id") REFERENCES "admin_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 在不可修改的审计历史追加旧管理资格快照；保留原有历史 actor 含义。
INSERT INTO "audit_logs" ("actor", "action", "target", "request_id", "metadata")
SELECT 'system', 'admin.legacy_access_removed', jsonb_build_object('type', 'user', 'id', "id"::text),
       'migration:20261008000000', jsonb_build_object('legacy_is_admin', true)
FROM "users" WHERE "is_admin" = true;

-- 撤销旧资格，避免回滚旧二进制时重新接受旧用户会话。普通用户登录态仍有效。
UPDATE "users" SET "is_admin" = false WHERE "is_admin" = true;

COMMIT;
