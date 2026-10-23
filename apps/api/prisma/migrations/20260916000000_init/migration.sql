-- 首版基线迁移：schema.prisma 生成的建表结构 + Prisma datamodel 无法表达的数据库对象（函数、触发器、CHECK、部分唯一索引、种子行）。
-- 已应用的迁移不可修改：Prisma 会校验校验和，结构变更必须新增迁移目录（pnpm --filter @sesame-notes/api db:migrate:dev）。
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserGender" AS ENUM ('UNSPECIFIED', 'MALE', 'FEMALE');

-- CreateEnum
CREATE TYPE "LedgerMemberType" AS ENUM ('REGISTERED', 'PLACEHOLDER');

-- CreateEnum
CREATE TYPE "LedgerMemberRole" AS ENUM ('owner', 'editor');

-- CreateEnum
CREATE TYPE "LedgerMemberStatus" AS ENUM ('ACTIVE', 'LEFT', 'REMOVED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "phone_e164" VARCHAR(16) NOT NULL,
    "sesame_number" CHAR(9) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fitness_spaces" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sync_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "fitness_spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fitness_entities" (
    "id" UUID NOT NULL,
    "fitness_space_id" UUID NOT NULL,
    "entity_type" VARCHAR(64) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(32),
    "occurrence_key" VARCHAR(255),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "fitness_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "display_name" VARCHAR(100),
    "gender" "UserGender" NOT NULL DEFAULT 'UNSPECIFIED',
    "avatar_file_id" VARCHAR(128),
    "avatar_version" INTEGER NOT NULL DEFAULT 0,
    "theme_primary_color" VARCHAR(7),
    "appearance" JSONB,
    "ai_config" JSONB,
    "primary_currency" VARCHAR(16),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL DEFAULT 'Unknown Device',
    "platform" VARCHAR(32) NOT NULL DEFAULT 'unknown',
    "app_version" VARCHAR(64),
    "os_version" VARCHAR(64),
    "device_model" VARCHAR(128),
    "last_ip" VARCHAR(64),
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "auth_generation" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledgers" (
    "id" UUID NOT NULL,
    "sync_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "currency" VARCHAR(16) NOT NULL DEFAULT 'CNY',
    "month_start_day" INTEGER NOT NULL DEFAULT 1,
    "aa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by_device_id" UUID,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledgers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_members" (
    "id" UUID NOT NULL,
    "ledger_id" UUID NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "member_type" "LedgerMemberType" NOT NULL,
    "linked_account_id" UUID,
    "role" "LedgerMemberRole" NOT NULL,
    "status" "LedgerMemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "archived_at" TIMESTAMPTZ(3),
    "archive_updated_at" TIMESTAMPTZ(3),
    "archive_updated_by_device_id" UUID,
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by_device_id" UUID,

    CONSTRAINT "ledger_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_invites" (
    "id" UUID NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    "code_prefix" VARCHAR(8) NOT NULL,
    "ledger_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "role" VARCHAR(16) NOT NULL DEFAULT 'editor',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "used_by_id" UUID,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "ledger_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "tx_type" VARCHAR(16) NOT NULL,
    "amount" DECIMAL(38,10) NOT NULL,
    "happened_at" TIMESTAMPTZ(3) NOT NULL,
    "note" TEXT,
    "category_id" UUID,
    "category_name" TEXT,
    "category_kind" VARCHAR(16),
    "exclude_from_stats" BOOLEAN NOT NULL DEFAULT false,
    "currency_code" VARCHAR(16) NOT NULL,
    "native_amount" DECIMAL(38,10) NOT NULL,
    "recurring_id" UUID,
    "created_by_member_id" UUID,
    "last_edited_by_member_id" UUID,
    "payer_member_id" UUID,
    "aa_mode" INTEGER,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "last_edited_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by_device_id" UUID,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_edit_history" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "ledger_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "operator_member_id" UUID,
    "changes" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_edit_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_splits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "transaction_id" UUID NOT NULL,
    "ledger_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "amount" DECIMAL(38,10) NOT NULL,

    CONSTRAINT "transaction_splits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_transactions" (
    "id" UUID NOT NULL,
    "ledger_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "tx_type" VARCHAR(16) NOT NULL,
    "amount" DECIMAL(38,10) NOT NULL,
    "currency_code" VARCHAR(16) NOT NULL,
    "category_id" UUID,
    "note" TEXT,
    "frequency" VARCHAR(16) NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 1,
    "day_of_month" INTEGER,
    "day_of_week" INTEGER,
    "month_of_year" INTEGER,
    "start_date" TIMESTAMPTZ(3) NOT NULL,
    "end_date" TIMESTAMPTZ(3),
    "last_generated_date" TIMESTAMPTZ(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by_device_id" UUID,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurring_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "icon" VARCHAR(255),
    "parent_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by_device_id" UUID,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rate_overrides" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "base_currency" VARCHAR(16) NOT NULL,
    "quote_currency" VARCHAR(16) NOT NULL,
    "rate" DECIMAL(38,18) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by_device_id" UUID,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "exchange_rate_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_changes" (
    "change_id" BIGSERIAL NOT NULL,
    "user_id" UUID,
    "ledger_id" UUID,
    "day_book_id" UUID,
    "memo_book_id" UUID,
    "fitness_space_id" UUID,
    "scope" VARCHAR(16) NOT NULL,
    "entity_type" VARCHAR(64) NOT NULL,
    "entity_id" UUID NOT NULL,
    "action" VARCHAR(16) NOT NULL,
    "mutation_id" UUID NOT NULL,
    "request_hash" VARCHAR(64),
    "payload" JSON NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "device_id" UUID NOT NULL,
    "recipient_user_id" UUID,

    CONSTRAINT "sync_changes_pkey" PRIMARY KEY ("change_id")
);

-- CreateTable
CREATE TABLE "day_books" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sync_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "day_books_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "day_events" (
    "id" UUID NOT NULL,
    "day_book_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "countdown_mode" TEXT,
    "interval_days" INTEGER,
    "repeat_type" TEXT NOT NULL,
    "statistic_type" TEXT NOT NULL,
    "event_calendar_type" TEXT,
    "event_original_year" INTEGER,
    "event_original_month" INTEGER,
    "event_original_day" INTEGER,
    "event_is_leap_month" BOOLEAN,
    "event_solar_date" DATE,
    "start_calendar_type" TEXT,
    "start_original_year" INTEGER,
    "start_original_month" INTEGER,
    "start_original_day" INTEGER,
    "start_is_leap_month" BOOLEAN,
    "start_solar_date" DATE,
    "end_calendar_type" TEXT,
    "end_original_year" INTEGER,
    "end_original_month" INTEGER,
    "end_original_day" INTEGER,
    "end_is_leap_month" BOOLEAN,
    "end_solar_date" DATE,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "updated_by_device_id" UUID,

    CONSTRAINT "day_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memo_books" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "sync_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "memo_books_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memo_entries" (
    "id" UUID NOT NULL,
    "memo_book_id" UUID NOT NULL,
    "book_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body_format" TEXT,
    "body" JSON,
    "account" BYTEA,
    "password" BYTEA,
    "phone" BYTEA,
    "email" BYTEA,
    "remark" BYTEA,
    "order_key" BIGINT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "memo_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" BIGSERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "response" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "generation" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_epochs" (
    "id" INTEGER NOT NULL DEFAULT 0,
    "auth_generation" UUID NOT NULL,
    "idempotency_generation" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "server_epochs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "actor" VARCHAR(255) NOT NULL,
    "action" VARCHAR(128) NOT NULL,
    "target" JSONB NOT NULL,
    "request_id" VARCHAR(128) NOT NULL,
    "ip" VARCHAR(64),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_e164_key" ON "users"("phone_e164");

-- CreateIndex
CREATE UNIQUE INDEX "users_sesame_number_key" ON "users"("sesame_number");

-- CreateIndex
CREATE INDEX "fitness_spaces_owner_id_deleted_at_updated_at_id_idx" ON "fitness_spaces"("owner_id", "deleted_at", "updated_at" DESC, "id");

-- CreateIndex
CREATE INDEX "fitness_entities_fitness_space_id_entity_type_id_idx" ON "fitness_entities"("fitness_space_id", "entity_type", "id");

-- CreateIndex
CREATE UNIQUE INDEX "fitness_entities_fitness_space_id_occurrence_key_key" ON "fitness_entities"("fitness_space_id", "occurrence_key");

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_user_id_key" ON "user_profiles"("user_id");

-- CreateIndex
CREATE INDEX "devices_user_id_revoked_at_idx" ON "devices"("user_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "devices_id_user_id_key" ON "devices"("id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_user_id_installation_id_key" ON "devices"("user_id", "installation_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_device_id_idx" ON "refresh_tokens"("user_id", "device_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledgers_sync_id_key" ON "ledgers"("sync_id");

-- CreateIndex
CREATE INDEX "ledgers_owner_id_deleted_at_idx" ON "ledgers"("owner_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "ledgers_id_owner_id_key" ON "ledgers"("id", "owner_id");

-- CreateIndex
CREATE INDEX "ledger_members_ledger_id_status_idx" ON "ledger_members"("ledger_id", "status");

-- CreateIndex
CREATE INDEX "ledger_members_linked_account_id_idx" ON "ledger_members"("linked_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_members_ledger_id_linked_account_id_key" ON "ledger_members"("ledger_id", "linked_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_members_id_ledger_id_key" ON "ledger_members"("id", "ledger_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_invites_code_hash_key" ON "ledger_invites"("code_hash");

-- CreateIndex
CREATE INDEX "ledger_invites_ledger_id_expires_at_idx" ON "ledger_invites"("ledger_id", "expires_at");

-- CreateIndex
CREATE INDEX "transactions_ledger_id_happened_at_id_idx" ON "transactions"("ledger_id", "happened_at", "id");

-- CreateIndex
CREATE INDEX "transactions_category_id_idx" ON "transactions"("category_id");

-- CreateIndex
CREATE INDEX "transactions_recurring_id_idx" ON "transactions"("recurring_id");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_id_ledger_id_key" ON "transactions"("id", "ledger_id");

-- CreateIndex
CREATE INDEX "transaction_edit_history_ledger_id_idx" ON "transaction_edit_history"("ledger_id");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_edit_history_transaction_id_version_key" ON "transaction_edit_history"("transaction_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_splits_transaction_id_member_id_key" ON "transaction_splits"("transaction_id", "member_id");

-- CreateIndex
CREATE INDEX "recurring_transactions_ledger_id_deleted_at_idx" ON "recurring_transactions"("ledger_id", "deleted_at");

-- CreateIndex
CREATE INDEX "recurring_transactions_category_id_idx" ON "recurring_transactions"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "recurring_transactions_id_ledger_id_key" ON "recurring_transactions"("id", "ledger_id");

-- CreateIndex
CREATE INDEX "categories_owner_id_deleted_at_kind_sort_order_idx" ON "categories"("owner_id", "deleted_at", "kind", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "categories_id_owner_id_key" ON "categories"("id", "owner_id");

-- CreateIndex
CREATE INDEX "exchange_rate_overrides_owner_id_deleted_at_idx" ON "exchange_rate_overrides"("owner_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rate_overrides_owner_id_base_currency_quote_curren_key" ON "exchange_rate_overrides"("owner_id", "base_currency", "quote_currency");

-- CreateIndex
CREATE INDEX "sync_changes_user_id_change_id_idx" ON "sync_changes"("user_id", "change_id");

-- CreateIndex
CREATE INDEX "sync_changes_ledger_id_change_id_idx" ON "sync_changes"("ledger_id", "change_id");

-- CreateIndex
CREATE INDEX "sync_changes_day_book_id_change_id_idx" ON "sync_changes"("day_book_id", "change_id");

-- CreateIndex
CREATE INDEX "sync_changes_memo_book_id_change_id_idx" ON "sync_changes"("memo_book_id", "change_id");

-- CreateIndex
CREATE INDEX "sync_changes_fitness_space_id_change_id_idx" ON "sync_changes"("fitness_space_id", "change_id");

-- CreateIndex
CREATE INDEX "sync_changes_recipient_user_id_change_id_idx" ON "sync_changes"("recipient_user_id", "change_id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_changes_device_id_mutation_id_key" ON "sync_changes"("device_id", "mutation_id");

-- CreateIndex
CREATE INDEX "day_books_owner_id_deleted_at_idx" ON "day_books"("owner_id", "deleted_at");

-- CreateIndex
CREATE INDEX "day_events_day_book_id_deleted_at_category_idx" ON "day_events"("day_book_id", "deleted_at", "category");

-- CreateIndex
CREATE INDEX "day_events_day_book_id_deleted_at_created_at_id_idx" ON "day_events"("day_book_id", "deleted_at", "created_at", "id");

-- CreateIndex
CREATE INDEX "memo_books_owner_id_deleted_at_updated_at_id_idx" ON "memo_books"("owner_id", "deleted_at", "updated_at" DESC, "id");

-- CreateIndex
CREATE UNIQUE INDEX "memo_books_id_type_key" ON "memo_books"("id", "type");

-- CreateIndex
CREATE INDEX "memo_entries_memo_book_id_deleted_at_created_at_id_idx" ON "memo_entries"("memo_book_id", "deleted_at", "created_at" DESC, "id");

-- CreateIndex
CREATE INDEX "memo_entries_memo_book_id_deleted_at_order_key_id_idx" ON "memo_entries"("memo_book_id", "deleted_at", "order_key", "id");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_user_id_key_key" ON "idempotency_keys"("user_id", "key");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- AddForeignKey
ALTER TABLE "fitness_spaces" ADD CONSTRAINT "fitness_spaces_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fitness_entities" ADD CONSTRAINT "fitness_entities_fitness_space_id_fkey" FOREIGN KEY ("fitness_space_id") REFERENCES "fitness_spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_device_id_user_id_fkey" FOREIGN KEY ("device_id", "user_id") REFERENCES "devices"("id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledgers" ADD CONSTRAINT "ledgers_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledgers" ADD CONSTRAINT "ledgers_updated_by_device_id_fkey" FOREIGN KEY ("updated_by_device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_members" ADD CONSTRAINT "ledger_members_ledger_id_fkey" FOREIGN KEY ("ledger_id") REFERENCES "ledgers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_members" ADD CONSTRAINT "ledger_members_linked_account_id_fkey" FOREIGN KEY ("linked_account_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_members" ADD CONSTRAINT "ledger_members_updated_by_device_id_fkey" FOREIGN KEY ("updated_by_device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_members" ADD CONSTRAINT "ledger_members_archive_updated_by_device_id_fkey" FOREIGN KEY ("archive_updated_by_device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_invites" ADD CONSTRAINT "ledger_invites_ledger_id_fkey" FOREIGN KEY ("ledger_id") REFERENCES "ledgers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_invites" ADD CONSTRAINT "ledger_invites_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_invites" ADD CONSTRAINT "ledger_invites_used_by_id_fkey" FOREIGN KEY ("used_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_ledger_owner_fkey" FOREIGN KEY ("ledger_id", "owner_id") REFERENCES "ledgers"("id", "owner_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transaction_created_by_member_fkey" FOREIGN KEY ("created_by_member_id", "ledger_id") REFERENCES "ledger_members"("id", "ledger_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transaction_last_edited_by_member_fkey" FOREIGN KEY ("last_edited_by_member_id", "ledger_id") REFERENCES "ledger_members"("id", "ledger_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transaction_payer_member_fkey" FOREIGN KEY ("payer_member_id", "ledger_id") REFERENCES "ledger_members"("id", "ledger_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_updated_by_device_id_fkey" FOREIGN KEY ("updated_by_device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_owner_fkey" FOREIGN KEY ("category_id", "owner_id") REFERENCES "categories"("id", "owner_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_recurring_ledger_fkey" FOREIGN KEY ("recurring_id", "ledger_id") REFERENCES "recurring_transactions"("id", "ledger_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transaction_edit_history" ADD CONSTRAINT "transaction_edit_history_transaction_ledger_fkey" FOREIGN KEY ("transaction_id", "ledger_id") REFERENCES "transactions"("id", "ledger_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transaction_edit_history" ADD CONSTRAINT "transaction_edit_operator_member_fkey" FOREIGN KEY ("operator_member_id", "ledger_id") REFERENCES "ledger_members"("id", "ledger_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_transaction_id_fkey" FOREIGN KEY ("transaction_id", "ledger_id") REFERENCES "transactions"("id", "ledger_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_split_member_fkey" FOREIGN KEY ("member_id", "ledger_id") REFERENCES "ledger_members"("id", "ledger_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transactions_ledger_owner_fkey" FOREIGN KEY ("ledger_id", "owner_id") REFERENCES "ledgers"("id", "owner_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transactions_updated_by_device_id_fkey" FOREIGN KEY ("updated_by_device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transactions_category_owner_fkey" FOREIGN KEY ("category_id", "owner_id") REFERENCES "categories"("id", "owner_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_updated_by_device_id_fkey" FOREIGN KEY ("updated_by_device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_owner_fkey" FOREIGN KEY ("parent_id", "owner_id") REFERENCES "categories"("id", "owner_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "exchange_rate_overrides" ADD CONSTRAINT "exchange_rate_overrides_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_rate_overrides" ADD CONSTRAINT "exchange_rate_overrides_updated_by_device_id_fkey" FOREIGN KEY ("updated_by_device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_changes" ADD CONSTRAINT "sync_changes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_changes" ADD CONSTRAINT "sync_changes_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_changes" ADD CONSTRAINT "sync_changes_ledger_id_fkey" FOREIGN KEY ("ledger_id") REFERENCES "ledgers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "day_books" ADD CONSTRAINT "day_books_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "day_events" ADD CONSTRAINT "day_events_day_book_id_fkey" FOREIGN KEY ("day_book_id") REFERENCES "day_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "day_events" ADD CONSTRAINT "day_events_updated_by_device_id_fkey" FOREIGN KEY ("updated_by_device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memo_books" ADD CONSTRAINT "memo_books_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memo_entries" ADD CONSTRAINT "memo_entries_memo_book_id_book_type_fkey" FOREIGN KEY ("memo_book_id", "book_type") REFERENCES "memo_books"("id", "type") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 数据库级不变量：Prisma datamodel 无法表达的数据库对象。
-- 表结构、枚举、普通索引、外键由本文件前半部分的建表 SQL 创建。

-- ===== uuid-ossp 扩展：REGISTERED 成员 v5 id 校验依赖 uuid_generate_v5 =====
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;

-- JSON 快照保留独立内容，数据库仍守住运行状态、有效组与周期安排的不变量。
CREATE FUNCTION public.fitness_payload_valid(kind TEXT, p JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $fitness$
DECLARE
  e JSONB; s JSONB; d JSONB; slot JSONB; segment JSONB; state JSONB; cycle JSONB; keys TEXT[];
  exercises JSONB; previous_end TIMESTAMPTZ; start_time TIMESTAMPTZ; end_time TIMESTAMPTZ;
  segment_count INTEGER; position INTEGER := 0;
BEGIN
  keys := CASE kind
    WHEN 'fitness_template' THEN ARRAY['name','exercises','created_at','updated_at']
    WHEN 'fitness_plan' THEN ARRAY['name','start_date','status','cycle_days','days','generation_state','pending_schedule','created_at','updated_at']
    WHEN 'fitness_workout' THEN ARRAY['name','scheduled_date','source_kind','source_plan_id','source_plan_name','source_template_id','occurrence_key','exercises','status','run_segments','rest_timer','created_at','updated_at']
    WHEN 'fitness_preferences' THEN ARRAY['custom_exercises','default_rest_seconds','sound_enabled','vibration_enabled','pinned_exercise_ids','exercise_weight_modes','created_at','updated_at']
    ELSE NULL END;
  IF keys IS NULL OR NOT p ?& keys THEN RETURN FALSE; END IF;
  -- 官方来源是可选识别信息，完整校验其字段和取值，不建立目录外键。
  IF kind IN ('fitness_template','fitness_plan') THEN
    keys := keys || ARRAY['catalog_origin'];
    IF p ? 'catalog_origin' THEN
      e := p->'catalog_origin';
      IF jsonb_typeof(e) IS DISTINCT FROM 'object'
        OR NOT e ?& ARRAY['source','item_id','revision']
        OR e - ARRAY['source','item_id','revision'] <> '{}'::jsonb
        OR e->>'source' IS DISTINCT FROM 'official'
        OR jsonb_typeof(e->'item_id') IS DISTINCT FROM 'string'
        OR (e->>'item_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR jsonb_typeof(e->'revision') IS DISTINCT FROM 'number'
        OR (e->>'revision') !~ '^[1-9][0-9]*$'
        OR (e->>'revision')::numeric > 2147483647 THEN RETURN FALSE; END IF;
    END IF;
  END IF;
  IF kind = 'fitness_preferences' THEN keys := keys || ARRAY['exercise_rest_settings']; END IF;
  IF p - keys <> '{}'::jsonb THEN RETURN FALSE; END IF;
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(p->'created_at') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p->'updated_at') IS DISTINCT FROM 'string'
    OR (p->>'updated_at')::timestamptz < (p->>'created_at')::timestamptz THEN RETURN FALSE; END IF;
  IF kind IN ('fitness_template','fitness_plan','fitness_workout') AND
    (jsonb_typeof(p->'name') IS DISTINCT FROM 'string' OR length(btrim(p->>'name')) NOT BETWEEN 1 AND 255) THEN RETURN FALSE; END IF;
  IF kind = 'fitness_preferences' THEN
    IF jsonb_typeof(p->'custom_exercises') IS DISTINCT FROM 'array'
      OR jsonb_array_length(p->'custom_exercises') > 1000 THEN RETURN FALSE; END IF;
    IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p->'custom_exercises')) <> jsonb_array_length(p->'custom_exercises') THEN RETURN FALSE; END IF;
    FOR e IN SELECT value FROM jsonb_array_elements(p->'custom_exercises') LOOP
      IF NOT e ?& ARRAY['id','name','body_part','equipment','icon','image','deleted']
        OR e - ARRAY['id','name','body_part','equipment','icon','image','deleted'] <> '{}'::jsonb
        OR jsonb_typeof(e->'id') IS DISTINCT FROM 'string'
        OR (e->>'id') !~ '^custom:[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR jsonb_typeof(e->'name') IS DISTINCT FROM 'string' OR length(btrim(e->>'name')) NOT BETWEEN 1 AND 255
        OR jsonb_typeof(e->'body_part') IS DISTINCT FROM 'string' OR length(btrim(e->>'body_part')) = 0
        OR jsonb_typeof(e->'equipment') IS DISTINCT FROM 'string' OR length(btrim(e->>'equipment')) = 0
        OR jsonb_typeof(e->'icon') IS DISTINCT FROM 'string' OR (e->>'icon') !~ '^[a-zA-Z][a-zA-Z0-9]{0,63}$'
        OR jsonb_typeof(e->'deleted') IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(e->'image') NOT IN ('null','string') THEN RETURN FALSE; END IF;
      IF jsonb_typeof(e->'image') = 'string' AND (length(e->>'image') NOT BETWEEN 1 AND 65536
        OR (e->>'image') !~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$') THEN RETURN FALSE; END IF;
    END LOOP;
    IF p ? 'exercise_rest_settings' THEN
      IF jsonb_typeof(p->'exercise_rest_settings') IS DISTINCT FROM 'object' THEN RETURN FALSE; END IF;
      FOR e IN SELECT value FROM jsonb_each(p->'exercise_rest_settings') LOOP
        IF NOT e ?& ARRAY['rest_seconds','warmup_rest_seconds'] OR e - ARRAY['rest_seconds','warmup_rest_seconds'] <> '{}'::jsonb
          OR jsonb_typeof(e->'rest_seconds') IS DISTINCT FROM 'number' OR jsonb_typeof(e->'warmup_rest_seconds') IS DISTINCT FROM 'number'
          OR (e->>'rest_seconds') !~ '^[0-9]+$' OR (e->>'warmup_rest_seconds') !~ '^[0-9]+$'
          OR (e->>'rest_seconds')::bigint NOT BETWEEN 0 AND 2147483647 OR (e->>'warmup_rest_seconds')::bigint NOT BETWEEN 0 AND 2147483647 THEN RETURN FALSE; END IF;
      END LOOP;
    END IF;
    RETURN jsonb_typeof(p->'default_rest_seconds') = 'number' AND (p->>'default_rest_seconds') ~ '^[0-9]+$' AND (p->>'default_rest_seconds')::numeric BETWEEN 0 AND 2147483647
      AND jsonb_typeof(p->'sound_enabled') = 'boolean' AND jsonb_typeof(p->'vibration_enabled') = 'boolean'
      AND jsonb_typeof(p->'pinned_exercise_ids') = 'array'
      AND jsonb_typeof(p->'exercise_weight_modes') = 'object'
      AND (SELECT count(*) FROM jsonb_object_keys(p->'exercise_weight_modes')) <= 1000
      AND NOT EXISTS (SELECT 1 FROM jsonb_each(p->'exercise_weight_modes') AS mode(key, value)
        WHERE length(btrim(mode.key)) NOT BETWEEN 1 AND 128 OR jsonb_typeof(mode.value) <> 'boolean');
  ELSIF kind = 'fitness_plan' THEN
    IF (p->>'cycle_days')::integer NOT BETWEEN 1 AND 36500 OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR (p->>'status') NOT IN ('in_progress','closed')
      OR jsonb_typeof(p->'days') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'days') <> (p->>'cycle_days')::integer
      OR (SELECT count(DISTINCT value->>'day_index') FROM jsonb_array_elements(p->'days')) <> (p->>'cycle_days')::integer
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p->'days') day WHERE jsonb_typeof(day->'slot') = 'object')
      OR jsonb_typeof(p->'generation_state') IS DISTINCT FROM 'object' THEN RETURN FALSE; END IF;
    FOR d IN SELECT value FROM jsonb_array_elements(p->'days') LOOP
      IF NOT d ?& ARRAY['day_index','slot'] OR d - ARRAY['day_index','slot'] <> '{}'::jsonb
        OR jsonb_typeof(d->'slot') NOT IN ('object','null')
        OR (d->>'day_index')::integer NOT BETWEEN 0 AND (p->>'cycle_days')::integer - 1 THEN RETURN FALSE; END IF;
      slot := d->'slot';
      IF slot <> 'null'::jsonb THEN
        IF NOT slot ?& ARRAY['id','source_template_id','name','exercises'] OR slot - ARRAY['id','source_template_id','name','exercises'] <> '{}'::jsonb
          OR NOT fitness_payload_valid('fitness_template', (slot - ARRAY['id','source_template_id']) || jsonb_build_object('created_at',p->'created_at','updated_at',p->'updated_at')) THEN RETURN FALSE; END IF;
      END IF;
    END LOOP;
    state := p->'generation_state';
    IF NOT state ?& ARRAY['next_cycle_start_date','next_cycle_index','generated_cycles']
      OR state - ARRAY['next_cycle_start_date','next_cycle_index','generated_cycles'] <> '{}'::jsonb
      OR jsonb_typeof(state->'generated_cycles') IS DISTINCT FROM 'array'
      OR (SELECT count(DISTINCT value->>'cycle_index') FROM jsonb_array_elements(state->'generated_cycles')) <> jsonb_array_length(state->'generated_cycles') THEN RETURN FALSE; END IF;
    FOR cycle IN SELECT value FROM jsonb_array_elements(state->'generated_cycles') LOOP
      IF NOT cycle ?& ARRAY['cycle_index','start_date','cycle_days','generated_from_date','rest_dates']
        OR cycle - ARRAY['cycle_index','start_date','cycle_days','generated_from_date','rest_dates'] <> '{}'::jsonb
        OR (cycle->>'cycle_index')::bigint NOT BETWEEN 0 AND (state->>'next_cycle_index')::bigint - 1
        OR (cycle->>'cycle_days')::integer NOT BETWEEN 1 AND 36500
        OR (cycle->>'generated_from_date')::date NOT BETWEEN (cycle->>'start_date')::date AND (cycle->>'start_date')::date + (cycle->>'cycle_days')::integer - 1
        OR jsonb_typeof(cycle->'rest_dates') IS DISTINCT FROM 'array'
        OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(cycle->'rest_dates')) <> jsonb_array_length(cycle->'rest_dates')
        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(cycle->'rest_dates') day WHERE day::date NOT BETWEEN (cycle->>'generated_from_date')::date AND (cycle->>'start_date')::date + (cycle->>'cycle_days')::integer - 1) THEN RETURN FALSE; END IF;
    END LOOP;
    IF p->>'pending_schedule' IS NOT NULL AND (jsonb_typeof(p->'pending_schedule') <> 'object'
      OR NOT (p->'pending_schedule') ?& ARRAY['cycle_days','days'] OR (p->'pending_schedule') - ARRAY['cycle_days','days'] <> '{}'::jsonb
      OR NOT fitness_payload_valid('fitness_plan', p || (p->'pending_schedule') || jsonb_build_object('pending_schedule',NULL))) THEN RETURN FALSE; END IF;
    RETURN (jsonb_typeof(p->'start_date') = 'null' AND p->>'status' <> 'in_progress' OR (p->>'start_date')::date IS NOT NULL) AND (p->'generation_state'->>'next_cycle_index')::bigint >= 0
      AND (jsonb_array_length(state->'generated_cycles') = 0 OR state->>'next_cycle_start_date' IS NOT NULL);
  ELSIF kind NOT IN ('fitness_template','fitness_workout') THEN RETURN FALSE;
  END IF;
  exercises := p->'exercises';
  IF jsonb_typeof(exercises) IS DISTINCT FROM 'array' THEN RETURN FALSE; END IF;
  IF kind = 'fitness_template' AND jsonb_array_length(exercises) = 0 THEN RETURN FALSE; END IF;
  IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(exercises)) <> jsonb_array_length(exercises) THEN RETURN FALSE; END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(exercises) LOOP
    IF NOT e ?& ARRAY['id','exercise_id','rest_seconds','warmup_rest_seconds','sets']
      OR e - ARRAY['id','exercise_id','rest_seconds','warmup_rest_seconds','sets'] <> '{}'::jsonb
      OR e->>'exercise_id' IS NULL OR length(e->>'exercise_id') NOT BETWEEN 1 AND 128
      OR jsonb_typeof(e->'sets') IS DISTINCT FROM 'array' OR (e->>'rest_seconds')::bigint < 0
      OR (e->>'warmup_rest_seconds')::bigint < 0 THEN RETURN FALSE; END IF;
    IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(e->'sets')) <> jsonb_array_length(e->'sets') THEN RETURN FALSE; END IF;
    FOR s IN SELECT value FROM jsonb_array_elements(e->'sets') LOOP
      keys := ARRAY['id','kind','weight','weight_left','weight_right','reps'];
      IF kind = 'fitness_workout' THEN keys := keys || ARRAY['completed']; END IF;
      IF kind = 'fitness_workout' AND s ? 'rest_durations_seconds' THEN
        keys := keys || ARRAY['rest_durations_seconds'];
        IF jsonb_typeof(s->'rest_durations_seconds') IS DISTINCT FROM 'array'
          OR jsonb_array_length(s->'rest_durations_seconds') > 1000
          OR (jsonb_array_length(s->'rest_durations_seconds') > 0 AND s->>'completed' IS DISTINCT FROM 'true') THEN RETURN FALSE; END IF;
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(s->'rest_durations_seconds') AS rest(value)
          WHERE jsonb_typeof(value) <> 'number' OR value::text !~ '^[0-9]+$' OR value::numeric > 2147483647) THEN RETURN FALSE; END IF;
      END IF;
      IF NOT s ?& keys OR s - keys <> '{}'::jsonb OR s->>'kind' IS NULL
        OR s->>'kind' NOT IN ('warmup','working')
        OR (s->>'weight') IS NOT NULL AND (jsonb_typeof(s->'weight') <> 'string' OR NOT (s->>'weight') ~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,10})?$')
        -- 左右重量各自满足 decimal 契约，出现时必须成对且不能与总重同时存在
        OR (s->>'weight_left') IS NOT NULL AND (jsonb_typeof(s->'weight_left') <> 'string' OR NOT (s->>'weight_left') ~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,10})?$')
        OR (s->>'weight_right') IS NOT NULL AND (jsonb_typeof(s->'weight_right') <> 'string' OR NOT (s->>'weight_right') ~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,10})?$')
        -- 一组不能同时保留总重与左右重量；只填单边是编辑中的草稿，允许保存
        OR (s->>'weight' IS NOT NULL AND (s->>'weight_left' IS NOT NULL OR s->>'weight_right' IS NOT NULL))
        OR (s->>'reps' IS NOT NULL AND (jsonb_typeof(s->'reps') <> 'number' OR (s->>'reps') !~ '^[0-9]+$' OR (s->>'reps')::numeric NOT BETWEEN 1 AND 2147483647)) THEN RETURN FALSE; END IF;
      IF kind = 'fitness_template' AND s ? 'completed' THEN RETURN FALSE; END IF;
      IF kind = 'fitness_workout' THEN
        IF jsonb_typeof(s->'completed') IS DISTINCT FROM 'boolean' THEN RETURN FALSE; END IF;
        IF (s->>'completed')::boolean AND (coalesce((s->>'reps')::bigint,0) <= 0 OR p->>'status' = 'scheduled') THEN RETURN FALSE; END IF;
        -- 完成组必须给出完整重量口径：总重、左右成对或完全留空（自重）
        IF (s->>'completed')::boolean AND (s->>'weight_left' IS NULL) <> (s->>'weight_right' IS NULL) THEN RETURN FALSE; END IF;
      END IF;
    END LOOP;
  END LOOP;
  IF kind = 'fitness_template' THEN RETURN TRUE; END IF;
  IF p->>'status' IS NULL OR p->>'status' NOT IN ('scheduled','in_progress','completed') OR jsonb_typeof(p->'run_segments') IS DISTINCT FROM 'array' THEN RETURN FALSE; END IF;
  segment_count := jsonb_array_length(p->'run_segments');
  IF p->>'status' = 'scheduled' THEN
    IF segment_count <> 0 OR p->>'rest_timer' IS NOT NULL THEN RETURN FALSE; END IF;
  ELSIF segment_count = 0
    OR (p->>'status' = 'completed' AND (p->'run_segments'->-1->>'ended_at') IS NULL) THEN RETURN FALSE; END IF;
  FOR segment IN SELECT value FROM jsonb_array_elements(p->'run_segments') LOOP
    IF NOT segment ?& ARRAY['started_at','ended_at'] OR segment - ARRAY['started_at','ended_at'] <> '{}'::jsonb THEN RETURN FALSE; END IF;
    position := position + 1;
    start_time := (segment->>'started_at')::timestamptz; end_time := (segment->>'ended_at')::timestamptz;
    IF start_time IS NULL OR end_time < start_time OR previous_end > start_time OR (end_time IS NULL AND position <> segment_count) THEN RETURN FALSE; END IF;
    previous_end := end_time;
  END LOOP;
  IF p->>'rest_timer' IS NOT NULL AND (p->>'status' <> 'in_progress' OR p->'rest_timer'->>'status' NOT IN ('running','paused')
    OR ((p->'rest_timer'->>'ends_at') IS NOT NULL) <> (p->'rest_timer'->>'status' = 'running')
    OR (p->'rest_timer'->>'remaining_seconds')::bigint < 0 OR (p->'rest_timer'->>'duration_seconds')::bigint < 0) THEN RETURN FALSE; END IF;
  IF p->'rest_timer' ? 'elapsed_seconds' AND (jsonb_typeof(p->'rest_timer'->'elapsed_seconds') IS DISTINCT FROM 'number'
    OR (p->'rest_timer'->>'elapsed_seconds') !~ '^[0-9]+$' OR (p->'rest_timer'->>'elapsed_seconds')::numeric > 2147483647) THEN RETURN FALSE; END IF;
  IF ((p->'rest_timer'->>'exercise_id') IS NULL) <> ((p->'rest_timer'->>'set_id') IS NULL) THEN RETURN FALSE; END IF;
  IF p->'rest_timer'->>'exercise_id' IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(exercises) AS ex(value), jsonb_array_elements(ex.value->'sets') AS st(value)
    WHERE ex.value->>'id' = p->'rest_timer'->>'exercise_id' AND st.value->>'id' = p->'rest_timer'->>'set_id'
      AND st.value->>'completed' = 'true'
  ) THEN RETURN FALSE; END IF;
  RETURN (p->>'scheduled_date')::date IS NOT NULL;
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END
$fitness$;

CREATE UNIQUE INDEX fitness_one_running_per_space ON public.fitness_entities(fitness_space_id) WHERE status='in_progress' AND deleted_at IS NULL;
CREATE FUNCTION public.enforce_fitness_identity()
RETURNS TRIGGER LANGUAGE plpgsql AS $fitness_identity$
DECLARE old_segment JSONB; new_segment JSONB; old_cycle JSONB; position INTEGER := 0;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.fitness_space_id IS DISTINCT FROM OLD.fitness_space_id OR NEW.entity_type IS DISTINCT FROM OLD.entity_type
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.occurrence_key IS DISTINCT FROM OLD.occurrence_key OR OLD.deleted_at IS NOT NULL OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'fitness identity and tombstone are immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.entity_type='fitness_workout' THEN
    IF (NEW.payload - ARRAY['name','exercises','status','run_segments','rest_timer','updated_at'])
      IS DISTINCT FROM (OLD.payload - ARRAY['name','exercises','status','run_segments','rest_timer','updated_at'])
      OR jsonb_array_length(NEW.payload->'run_segments') < jsonb_array_length(OLD.payload->'run_segments') THEN
      RAISE EXCEPTION 'fitness workout source or runtime is immutable' USING ERRCODE='23514';
    END IF;
    FOR old_segment IN SELECT value FROM jsonb_array_elements(OLD.payload->'run_segments') LOOP
      new_segment := NEW.payload->'run_segments'->position; position := position + 1;
      IF new_segment->>'started_at' IS DISTINCT FROM old_segment->>'started_at'
        OR old_segment->>'ended_at' IS NOT NULL AND new_segment->>'ended_at' IS DISTINCT FROM old_segment->>'ended_at' THEN
        RAISE EXCEPTION 'fitness historical runtime is immutable' USING ERRCODE='23514';
      END IF;
    END LOOP;
  ELSIF OLD.entity_type='fitness_plan' THEN
    IF NEW.payload->>'status' = 'in_progress'
      AND jsonb_array_length(OLD.payload->'generation_state'->'generated_cycles') > 0
      AND NEW.payload->>'start_date' IS DISTINCT FROM OLD.payload->>'start_date'
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.payload->'generation_state'->'generated_cycles') cycle
        WHERE (cycle->>'cycle_index')::bigint >= (OLD.payload->'generation_state'->>'next_cycle_index')::bigint
          AND cycle->>'start_date' = NEW.payload->>'start_date') THEN
      RAISE EXCEPTION 'fitness restart requires a new cycle' USING ERRCODE='23514';
    END IF;
    IF (NEW.payload->'generation_state'->>'next_cycle_index')::bigint < (OLD.payload->'generation_state'->>'next_cycle_index')::bigint THEN
      RAISE EXCEPTION 'fitness generated schedule is immutable' USING ERRCODE='23514';
    END IF;
    FOR old_cycle IN SELECT value FROM jsonb_array_elements(OLD.payload->'generation_state'->'generated_cycles') LOOP
      IF NOT (NEW.payload->'generation_state'->'generated_cycles' @> jsonb_build_array(old_cycle)) THEN
        RAISE EXCEPTION 'fitness generated cycle is immutable' USING ERRCODE='23514';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END
$fitness_identity$;
CREATE TRIGGER fitness_identity BEFORE UPDATE ON public.fitness_entities FOR EACH ROW EXECUTE FUNCTION enforce_fitness_identity();

-- ===== 业务格式与跨列 CHECK 约束：直接创建当前定义 =====
DO $inv$
DECLARE
  v RECORD;
BEGIN
  FOR v IN SELECT * FROM (VALUES
    ('categories', 'categories_kind_check', $c$kind = 'expense'$c$),
    ('categories', 'categories_level_check', $c$((level = 1) AND (parent_id IS NULL)) OR ((level = 2) AND (parent_id IS NOT NULL))$c$),
    ('exchange_rate_overrides', 'exchange_rate_overrides_currency_check', $c$((base_currency)::text ~ '^[A-Z]{3}$'::text) AND ((quote_currency)::text ~ '^[A-Z]{3}$'::text) AND ((base_currency)::text <> (quote_currency)::text)$c$),
    ('exchange_rate_overrides', 'exchange_rate_overrides_rate_check', $c$rate > (0)::numeric$c$),
    ('ledger_invites', 'ledger_invites_role_check', $c$(role)::text = 'editor'::text$c$),
    ('ledger_members', 'ledger_members_registered_id_v5_check', $c$(member_type <> 'REGISTERED'::"LedgerMemberType") OR (id = uuid_generate_v5(ledger_id, ('user:'::text || (linked_account_id)::text)))$c$),
    ('ledger_members', 'ledger_members_role_check', $c$role = ANY (ARRAY['owner'::"LedgerMemberRole", 'editor'::"LedgerMemberRole"])$c$),
    ('ledger_members', 'ledger_members_type_account_check', $c$((member_type = 'REGISTERED'::"LedgerMemberType") AND (linked_account_id IS NOT NULL)) OR ((member_type = 'PLACEHOLDER'::"LedgerMemberType") AND (linked_account_id IS NULL))$c$),
    ('ledgers', 'ledgers_currency_check', $c$(currency)::text ~ '^[A-Z]{3}$'::text$c$),
    ('ledgers', 'ledgers_month_start_day_check', $c$(month_start_day >= 1) AND (month_start_day <= 31)$c$),
    ('recurring_transactions', 'recurring_transactions_amount_check', $c$amount > (0)::numeric$c$),
    ('recurring_transactions', 'recurring_transactions_currency_check', $c$(currency_code)::text ~ '^[A-Z]{3}$'::text$c$),
    ('recurring_transactions', 'recurring_transactions_frequency_check', $c$frequency IN ('daily', 'weekly', 'monthly', 'yearly')$c$),
    ('recurring_transactions', 'recurring_transactions_rule_check', $c$("interval" >= 1) AND ((day_of_month IS NULL) OR ((day_of_month >= 1) AND (day_of_month <= 31))) AND ((day_of_week IS NULL) OR ((day_of_week >= 1) AND (day_of_week <= 7))) AND ((month_of_year IS NULL) OR ((month_of_year >= 1) AND (month_of_year <= 12))) AND ((end_date IS NULL) OR (end_date >= start_date))$c$),
    ('recurring_transactions', 'recurring_transactions_type_check', $c$tx_type = 'expense'$c$),
    ('server_epochs', 'server_epochs_id_check', $c$id = 0$c$),
    ('sync_changes', 'sync_changes_action_check', $c$action IN ('upsert', 'delete')$c$),
    ('sync_changes', 'sync_changes_entity_type_check', $c$entity_type IN ('ledger', 'ledger_archive', 'transaction', 'category', 'recurring_transaction', 'exchange_rate_override', 'member', 'day_book', 'day_event', 'memo_book', 'memo_entry','fitness_space','fitness_template','fitness_plan','fitness_workout','fitness_preferences')$c$),
    ('sync_changes', 'sync_changes_fitness_scope_check', $c$(entity_type LIKE 'fitness_%' AND scope='user' AND user_id IS NOT NULL AND ledger_id IS NULL AND day_book_id IS NULL AND memo_book_id IS NULL AND fitness_space_id IS NOT NULL AND recipient_user_id IS NULL AND (entity_type<>'fitness_space' OR entity_id=fitness_space_id)) OR (entity_type NOT LIKE 'fitness_%' AND fitness_space_id IS NULL)$c$),
    ('fitness_entities', 'fitness_entities_shape_check', $c$revision >= 1 AND fitness_payload_valid(entity_type,payload) IS TRUE AND created_at=(payload->>'created_at')::timestamptz AND (deleted_at IS NOT NULL OR updated_at=(payload->>'updated_at')::timestamptz) AND ((entity_type='fitness_workout' AND status IS NOT NULL AND status=payload->>'status' AND occurrence_key IS NOT DISTINCT FROM payload->>'occurrence_key') OR (entity_type<>'fitness_workout' AND status IS NULL AND occurrence_key IS NULL)) AND (entity_type<>'fitness_preferences' OR id=fitness_space_id)$c$),
    ('fitness_entities', 'fitness_entities_occurrence_check', $c$entity_type<>'fitness_workout' OR ((payload->>'source_kind'='plan' AND occurrence_key IS NOT NULL AND payload->>'source_plan_id' IS NOT NULL AND payload->>'source_plan_name' IS NOT NULL AND split_part(occurrence_key,':',1)=payload->>'source_plan_id' AND id=uuid_generate_v5((payload->>'source_plan_id')::uuid,occurrence_key)) OR (payload->>'source_kind' IN ('blank','template') AND occurrence_key IS NULL AND payload->>'source_plan_id' IS NULL AND payload->>'source_plan_name' IS NULL))$c$),
    ('sync_changes','sync_changes_memo_scope_check',$c$(entity_type IN ('memo_book','memo_entry') AND scope='user' AND user_id IS NOT NULL AND ledger_id IS NULL AND day_book_id IS NULL AND recipient_user_id IS NULL AND memo_book_id IS NOT NULL AND (entity_type<>'memo_book' OR entity_id=memo_book_id)) OR (entity_type NOT IN ('memo_book','memo_entry') AND memo_book_id IS NULL)$c$),
    ('fitness_spaces','fitness_spaces_shape_check',$c$revision>=1 AND char_length(name)>0$c$),
    ('memo_books','memo_books_shape_check',$c$type IN ('normal','credentials') AND revision>=1 AND char_length(name)>0$c$),
    ('memo_entries','memo_entries_shape_check',$c$revision>=1 AND ((book_type='normal' AND body_format IS NOT NULL AND body_format='delta_v1' AND body IS NOT NULL AND json_typeof(body)='object' AND account IS NULL AND password IS NULL AND phone IS NULL AND email IS NULL AND remark IS NULL AND order_key IS NULL) OR (book_type='credentials' AND body_format IS NULL AND body IS NULL AND char_length(title)>0 AND account IS NOT NULL AND octet_length(account)>0 AND password IS NOT NULL AND octet_length(password)>0 AND phone IS NOT NULL AND email IS NOT NULL AND remark IS NOT NULL AND order_key IS NOT NULL AND order_key>=0))$c$),
    ('sync_changes', 'sync_changes_day_scope_check', $c$(entity_type IN ('day_book', 'day_event') AND scope = 'user' AND user_id IS NOT NULL AND ledger_id IS NULL AND recipient_user_id IS NULL AND day_book_id IS NOT NULL AND (entity_type <> 'day_book' OR entity_id = day_book_id)) OR (entity_type NOT IN ('day_book', 'day_event') AND day_book_id IS NULL)$c$),
    ('day_books', 'day_books_revision_check', $c$revision >= 1$c$),
    ('day_books', 'day_books_name_check', $c$char_length(name) BETWEEN 1 AND 100 AND name = btrim(name, U&'\0009\000a\000b\000c\000d\0020\0085\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000\feff')$c$),
    ('day_events', 'day_events_revision_check', $c$revision >= 1$c$),
    ('day_events', 'day_events_name_check', $c$char_length(name) BETWEEN 1 AND 100 AND name = btrim(name, U&'\0009\000a\000b\000c\000d\0020\0085\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000\feff')$c$),
    ('day_events', 'day_events_definition_check', $c$
      statistic_type IN ('year', 'day') AND (
        (category IN ('birthday', 'anniversary') AND event_solar_date IS NOT NULL AND start_solar_date IS NULL AND end_solar_date IS NULL AND countdown_mode IS NULL AND interval_days IS NULL AND repeat_type = 'yearly')
        OR (category = 'countdown' AND countdown_mode IS NOT NULL AND countdown_mode = 'fixed_date' AND event_solar_date IS NOT NULL AND start_solar_date IS NULL AND end_solar_date IS NULL AND interval_days IS NULL AND repeat_type = 'none')
        OR (category = 'countdown' AND countdown_mode IS NOT NULL AND countdown_mode = 'interval_days' AND event_solar_date IS NULL AND start_solar_date IS NOT NULL AND end_solar_date IS NULL AND interval_days IS NOT NULL AND interval_days BETWEEN 1 AND 36500 AND start_solar_date + interval_days - 1 <= DATE '2100-12-31' AND repeat_type = 'none')
        OR (category = 'stage' AND event_solar_date IS NULL AND start_solar_date IS NOT NULL AND countdown_mode IS NULL AND interval_days IS NULL AND repeat_type = 'none' AND (end_solar_date IS NULL OR end_solar_date >= start_solar_date))
      )$c$),
    ('sync_changes', 'sync_changes_scope_check', $c$(((scope)::text = 'user'::text) AND (ledger_id IS NULL)) OR (((scope)::text = 'ledger'::text) AND (ledger_id IS NOT NULL))$c$),
    ('transaction_splits', 'transaction_splits_amount_check', $c$amount > (0)::numeric$c$),
    ('transaction_splits', 'transaction_splits_participant_check', $c$member_id IS NOT NULL$c$),
    ('transactions', 'transactions_aa_mode_check', $c$(aa_mode IS NULL) OR (aa_mode = ANY (ARRAY[0, 1, 2]))$c$),
    ('transactions', 'transactions_amount_check', $c$(amount > (0)::numeric) AND (native_amount > (0)::numeric)$c$),
    ('transactions', 'transactions_currency_check', $c$(currency_code)::text ~ '^[A-Z]{3}$'::text$c$),
    ('transactions', 'transactions_type_check', $c$tx_type = 'expense'$c$),
    ('transactions', 'transactions_category_kind_check', $c$category_kind IS NULL OR category_kind = 'expense'$c$),
    ('transactions', 'transactions_revision_check', $c$revision >= 1$c$),
    ('user_profiles', 'user_profiles_avatar_version_check', $c$avatar_version >= 0$c$),
    ('users', 'users_phone_e164_check', $c$(phone_e164)::text ~ '^\+[1-9][0-9]{7,14}$'::text$c$),
    ('users', 'users_sesame_number_check', $c$sesame_number ~ '^[1-9][0-9]{8}$'::text$c$)
  ) AS t(tbl, name, expr)
  LOOP
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%s)', v.tbl, v.name, v.expr);
  END LOOP;
END
$inv$;

-- 三个日期端点共用完整组、真实公历投影和原始日期范围约束。
DO $day_dates$
DECLARE
  prefix TEXT;
  definition TEXT;
BEGIN
  FOREACH prefix IN ARRAY ARRAY['event', 'start', 'end'] LOOP
    definition := format($check$
      (%1$s_calendar_type IS NULL AND %1$s_original_year IS NULL AND %1$s_original_month IS NULL AND %1$s_original_day IS NULL AND %1$s_is_leap_month IS NULL AND %1$s_solar_date IS NULL)
      OR (%1$s_calendar_type IS NOT NULL AND %1$s_original_year IS NOT NULL AND %1$s_original_month IS NOT NULL AND %1$s_original_day IS NOT NULL AND %1$s_is_leap_month IS NOT NULL AND %1$s_solar_date IS NOT NULL
        AND %1$s_calendar_type IN ('solar', 'lunar') AND %1$s_original_month BETWEEN 1 AND 12 AND %1$s_original_day BETWEEN 1 AND 31
        AND %1$s_solar_date BETWEEN DATE '1901-01-01' AND DATE '2100-12-31'
        AND ((%1$s_calendar_type = 'lunar' AND %1$s_original_year BETWEEN 1900 AND 2100 AND %1$s_original_day <= 30)
          OR (%1$s_calendar_type = 'solar' AND %1$s_original_year BETWEEN 1901 AND 2100 AND NOT %1$s_is_leap_month
            AND extract(year FROM %1$s_solar_date) = %1$s_original_year AND extract(month FROM %1$s_solar_date) = %1$s_original_month AND extract(day FROM %1$s_solar_date) = %1$s_original_day)))
      $check$, prefix);
    EXECUTE format('ALTER TABLE public.day_events ADD CONSTRAINT %I CHECK (%s)', 'day_events_' || prefix || '_date_check', definition);
  END LOOP;
END
$day_dates$;

-- ===== 部分唯一索引：每账本恰有一个 owner 成员（Prisma 无法表达 WHERE 条件）=====
CREATE UNIQUE INDEX ledger_members_one_owner_per_ledger
  ON public.ledger_members USING btree (ledger_id) WHERE (role = 'owner'::"LedgerMemberRole");

-- ===== 账本 Owner 守卫：跨表不变量延迟到事务末尾校验 =====
CREATE FUNCTION public.enforce_ledger_owner_member()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
  DECLARE
    ledger_ids UUID[];
    ledger_id_to_check UUID;
  BEGIN
    IF TG_TABLE_NAME = 'ledgers' THEN
      ledger_ids := ARRAY[NEW."id"];
    ELSIF TG_OP = 'DELETE' THEN
      ledger_ids := ARRAY[OLD."ledger_id"];
    ELSIF TG_OP = 'UPDATE' THEN
      ledger_ids := ARRAY[OLD."ledger_id", NEW."ledger_id"];
    ELSE
      ledger_ids := ARRAY[NEW."ledger_id"];
    END IF;

    FOREACH ledger_id_to_check IN ARRAY ledger_ids LOOP
      IF EXISTS (
        SELECT 1
        FROM "ledgers" l
        WHERE l."id" = ledger_id_to_check
          AND NOT EXISTS (
            SELECT 1
            FROM "ledger_members" m
            WHERE m."ledger_id" = l."id"
              AND m."role" = 'owner'
              AND m."status" = 'ACTIVE'
              AND m."member_type" = 'REGISTERED'
              AND m."linked_account_id" = l."owner_id"
          )
      ) THEN
        RAISE EXCEPTION '账本 % 必须恰有一个与 owner_id 一致的 ACTIVE REGISTERED owner 成员', ledger_id_to_check
          USING ERRCODE = '23514', CONSTRAINT = 'ledger_owner_member_guard';
      END IF;
    END LOOP;
    RETURN NULL;
  END
  $function$;

-- ===== 审计日志只追加守卫 =====
CREATE FUNCTION public.reject_audit_log_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
  BEGIN
    RAISE EXCEPTION '审计日志只允许追加' USING ERRCODE = '55000';
  END
  $function$;

-- ===== 守卫触发器=====
CREATE TRIGGER audit_logs_reject_truncate BEFORE TRUNCATE ON public.audit_logs FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_log_mutation();

CREATE TRIGGER audit_logs_reject_update_delete BEFORE DELETE OR UPDATE ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();

CREATE CONSTRAINT TRIGGER ledger_members_owner_member_guard AFTER INSERT OR DELETE OR UPDATE ON public.ledger_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_ledger_owner_member();

CREATE CONSTRAINT TRIGGER ledgers_owner_member_guard AFTER INSERT OR UPDATE ON public.ledgers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_ledger_owner_member();

-- ===== server_epochs 单行种子：认证/幂等 generation 的权威来源=====
INSERT INTO public."server_epochs" ("id", "auth_generation", "idempotency_generation", "updated_at")
VALUES (0, gen_random_uuid(), gen_random_uuid(), CURRENT_TIMESTAMP);

-- 备忘录类型和归属是身份，恢复必须使用明确的删除/重建事务。
CREATE FUNCTION public.enforce_memo_identity()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_TABLE_NAME = 'memo_books' THEN
    IF NEW.type IS DISTINCT FROM OLD.type OR NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
      RAISE EXCEPTION 'MEMO_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.memo_book_id IS DISTINCT FROM OLD.memo_book_id OR NEW.book_type IS DISTINCT FROM OLD.book_type THEN
      RAISE EXCEPTION 'MEMO_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER memo_book_identity BEFORE UPDATE ON public.memo_books FOR EACH ROW EXECUTE FUNCTION enforce_memo_identity();
CREATE TRIGGER memo_entry_identity BEFORE UPDATE ON public.memo_entries FOR EACH ROW EXECUTE FUNCTION enforce_memo_identity();

-- 私有父本归属不可直接改写；移动与恢复使用已有受控流程。
CREATE FUNCTION public.enforce_private_book_owner()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'BOOK_IDENTITY_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER fitness_space_identity BEFORE UPDATE ON public.fitness_spaces FOR EACH ROW EXECUTE FUNCTION enforce_private_book_owner();
CREATE TRIGGER memo_book_owner BEFORE UPDATE ON public.memo_books FOR EACH ROW EXECUTE FUNCTION enforce_private_book_owner();

-- 来源可以晚到或已删除，但任何已存在的来源和引用方必须在同一空间。
-- ponytail: JSON 来源检查扫描跨空间记录；数据量扩大时将来源关系规范化为带复合外键的关联表。
CREATE FUNCTION public.enforce_fitness_space_references()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.fitness_entities e
    WHERE e.fitness_space_id <> NEW.fitness_space_id AND (
      jsonb_path_exists(NEW.payload, '$.** ? (@.source_plan_id == $id || @.source_template_id == $id)', jsonb_build_object('id', e.id::text)) OR
      jsonb_path_exists(e.payload, '$.** ? (@.source_plan_id == $id || @.source_template_id == $id)', jsonb_build_object('id', NEW.id::text))
    )
  ) THEN RAISE EXCEPTION 'FITNESS_CROSS_SPACE_REFERENCE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$function$;
CREATE CONSTRAINT TRIGGER fitness_space_references AFTER INSERT OR UPDATE ON public.fitness_entities
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_fitness_space_references();
