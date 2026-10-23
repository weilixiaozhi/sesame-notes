-- 永久同步占用独立于可过期 HTTP 响应；业务候选仍保存自己的内容与处理结果。
BEGIN;
CREATE TYPE "MutationReservationScope" AS ENUM ('device', 'account');

CREATE TABLE "mutation_reservations" (
    "scope" "MutationReservationScope" NOT NULL,
    "user_id" UUID NOT NULL,
    "scope_id" UUID NOT NULL,
    "mutation_id" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mutation_reservations_pkey" PRIMARY KEY ("scope", "user_id", "scope_id", "mutation_id"),
    CONSTRAINT "mutation_reservations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "mutation_reservations_user_id_idx" ON "mutation_reservations"("user_id");

-- 新表只承载原有永久身份，不扩大不同账号间的来源冲突范围。
INSERT INTO "mutation_reservations" ("scope", "user_id", "scope_id", "mutation_id", "request_hash", "created_at")
SELECT 'device', "owner_id", "source_device_id", "source_mutation_id", "request_hash", "created_at"
FROM "category_conflicts";

-- 已确认命令保持账号级唯一性，换设备重放仍由原候选结果响应。
INSERT INTO "mutation_reservations" ("scope", "user_id", "scope_id", "mutation_id", "request_hash", "created_at")
SELECT 'account', "owner_id", "owner_id", "resolution_mutation_id", "resolution_hash", "resolved_at"
FROM "category_conflicts" WHERE "status" = 'resolved';

-- 暂存历史无变更回执；不合法身份或同身份不同指纹必须中止迁移，不能丢弃占用证据。
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "idempotency_keys"
    WHERE "key" LIKE 'category-source:%' AND "key" !~
      '^category-source:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
  ) THEN
    RAISE EXCEPTION '永久同步来源回执身份格式无效，迁移已停止';
  END IF;
END $$;

CREATE TEMPORARY TABLE "legacy_mutation_reservations" ON COMMIT DROP AS
SELECT "user_id", split_part("key", ':', 2)::UUID AS "scope_id",
       split_part("key", ':', 3)::UUID AS "mutation_id", "request_hash", "created_at"
FROM "idempotency_keys" WHERE "key" LIKE 'category-source:%';

DO $$ BEGIN
  -- UUID 大小写及文本编码归一化后，同一账号来源不能携带多个不同指纹。
  IF EXISTS (
    SELECT 1 FROM "legacy_mutation_reservations"
    GROUP BY "user_id", "scope_id", "mutation_id"
    HAVING count(DISTINCT "request_hash") > 1
  ) THEN
    RAISE EXCEPTION '历史永久同步来源身份存在不一致指纹，迁移已停止';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "legacy_mutation_reservations" old
    JOIN "mutation_reservations" current
      ON current."scope" = 'device' AND current."user_id" = old."user_id"
      AND current."scope_id" = old."scope_id" AND current."mutation_id" = old."mutation_id"
    WHERE current."request_hash" <> old."request_hash"
  ) THEN
    RAISE EXCEPTION '永久同步来源身份存在不一致指纹，迁移已停止';
  END IF;
END $$;

INSERT INTO "mutation_reservations" ("scope", "user_id", "scope_id", "mutation_id", "request_hash", "created_at")
SELECT 'device', "user_id", "scope_id", "mutation_id", "request_hash", "created_at"
FROM "legacy_mutation_reservations"
ON CONFLICT ("scope", "user_id", "scope_id", "mutation_id") DO NOTHING;

DELETE FROM "idempotency_keys" WHERE "key" LIKE 'category-source:%';
COMMIT;
