-- 账号手机号由非空区号与非空本地数字组成，总长度保持数据库字段上限。
ALTER TABLE "users"
  DROP CONSTRAINT "users_phone_e164_check",
  ADD CONSTRAINT "users_phone_e164_check"
  CHECK (phone_e164 ~ '^\+[1-9][0-9]{1,14}$');
