-- 账号密码卡片从固定五列改为可自定义字段列表。
-- 旧卡片没有需要保留的内容：容器本、内容以及引用它们的变更行一并清理，
-- 否则客户端按变更行增量拉取时会把已删除的账号密码本重新建回本地。
DELETE FROM "sync_changes"
WHERE "entity_type" IN ('memo_book', 'memo_entry')
  AND "memo_book_id" IN (SELECT "id" FROM "memo_books" WHERE "type" = 'credentials');

DELETE FROM "memo_books" WHERE "type" = 'credentials';

-- AlterTable
ALTER TABLE "memo_entries"
  DROP COLUMN "account",
  DROP COLUMN "password",
  DROP COLUMN "phone",
  DROP COLUMN "email",
  DROP COLUMN "remark";

-- 字段列表落在 body（fields_v1）；普通笔记分支与既有语义保持等价。
-- 旧 CHECK 引用了被删除的列，DROP COLUMN 时已被 PostgreSQL 一并移除。
ALTER TABLE "memo_entries" ADD CONSTRAINT "memo_entries_shape_check" CHECK (
  revision>=1 AND (
    (book_type='normal' AND body_format IS NOT NULL AND body_format='delta_v1' AND body IS NOT NULL AND json_typeof(body)='object' AND order_key IS NULL)
    OR (book_type='credentials' AND body_format IS NOT NULL AND body_format='fields_v1' AND body IS NOT NULL AND json_typeof(body)='object' AND order_key IS NOT NULL AND order_key>=0)
  )
);
