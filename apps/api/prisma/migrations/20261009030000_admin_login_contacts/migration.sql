-- 联系方式为可选登录凭据；空值可重复，已登记凭据在软删除后仍保留唯一性。
BEGIN;

ALTER TABLE "admin_accounts"
  ADD COLUMN "email" VARCHAR(254),
  ADD COLUMN "phone" VARCHAR(16),
  ADD CONSTRAINT "admin_accounts_email_canonical_check" CHECK (
    "email" IS NULL OR (
      "email" = lower(btrim("email"))
      AND "email" ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
    )
  ),
  ADD CONSTRAINT "admin_accounts_phone_canonical_check" CHECK (
    "phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{5,14}$'
  );

CREATE UNIQUE INDEX "admin_accounts_email_key" ON "admin_accounts"("email");
CREATE UNIQUE INDEX "admin_accounts_phone_key" ON "admin_accounts"("phone");

COMMIT;
