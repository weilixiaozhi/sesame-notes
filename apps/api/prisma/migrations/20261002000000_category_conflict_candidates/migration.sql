BEGIN;
-- 仅新增候选表，既有分类、交易身份、名称及历史数据均不重写。
CREATE TABLE "category_conflicts" (
  "id" UUID NOT NULL,
  "owner_id" UUID NOT NULL,
  "category_id" UUID NOT NULL,
  "template_key" VARCHAR(128) NOT NULL,
  "source_device_id" UUID NOT NULL,
  "source_mutation_id" UUID NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "candidate_version" INTEGER NOT NULL DEFAULT 1,
  "action" VARCHAR(16) NOT NULL,
  "local_payload" JSONB NOT NULL,
  "local_updated_at" TIMESTAMPTZ(3) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
  "resolution" VARCHAR(16),
  "resolution_mutation_id" UUID,
  "resolution_hash" CHAR(64),
  "resolution_result" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ(3),
  CONSTRAINT "category_conflicts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "category_conflicts_owner_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "category_conflicts_category_fkey" FOREIGN KEY ("category_id", "owner_id") REFERENCES "categories"("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "category_conflicts_state_check" CHECK (
    "candidate_version" > 0 AND "action" IN ('upsert', 'delete') AND
    (("status" = 'pending' AND "resolution" IS NULL AND "resolved_at" IS NULL AND "resolution_mutation_id" IS NULL AND "resolution_hash" IS NULL AND "resolution_result" IS NULL) OR
     ("status" = 'resolved' AND "resolution" IS NOT NULL AND "resolution" IN ('cloud', 'local') AND "resolved_at" IS NOT NULL AND "resolution_mutation_id" IS NOT NULL AND "resolution_hash" IS NOT NULL AND "resolution_result" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "category_conflicts_source_key"
ON "category_conflicts" ("owner_id", "source_device_id", "source_mutation_id");
CREATE INDEX "category_conflicts_owner_status_page_idx"
ON "category_conflicts" ("owner_id", "status", "created_at" DESC, "id");
CREATE UNIQUE INDEX "category_conflicts_resolution_key"
ON "category_conflicts" ("owner_id", "resolution_mutation_id");
COMMIT;
