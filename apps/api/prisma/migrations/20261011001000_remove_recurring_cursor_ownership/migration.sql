-- 周期生成与历史迁入维护实际发生进度，规则元数据不携带接管状态。
ALTER TABLE "recurring_transactions" DROP COLUMN "cursor_managed";
