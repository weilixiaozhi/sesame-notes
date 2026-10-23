-- 每个账号独立保存凭据版本；存量访问令牌按版本 0 校验。
ALTER TABLE "users" ADD COLUMN "credential_version" INTEGER NOT NULL DEFAULT 0;
