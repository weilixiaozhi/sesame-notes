BEGIN;

-- 分类身份由复合主键统一承载，引用约束在同一事务内重新绑定该主键。
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_category_owner_fkey";
ALTER TABLE "recurring_transactions" DROP CONSTRAINT "recurring_transactions_category_owner_fkey";
ALTER TABLE "categories" DROP CONSTRAINT "categories_parent_owner_fkey";
DROP INDEX "categories_id_owner_id_key";

ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_owner_fkey"
  FOREIGN KEY ("category_id", "owner_id") REFERENCES "categories"("id", "owner_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transactions_category_owner_fkey"
  FOREIGN KEY ("category_id", "owner_id") REFERENCES "categories"("id", "owner_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_owner_fkey"
  FOREIGN KEY ("parent_id", "owner_id") REFERENCES "categories"("id", "owner_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT;
