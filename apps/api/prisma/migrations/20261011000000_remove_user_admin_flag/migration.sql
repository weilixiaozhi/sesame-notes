-- 普通应用账号的身份不参与后台授权，后台账号由独立身份表管理。
ALTER TABLE "users" DROP COLUMN "is_admin";
