-- 账号级命令须检查所有设备的来源身份，复合索引避免在全局提交锁内扫描账号全部历史。
CREATE INDEX "mutation_reservations_user_id_mutation_id_idx" ON "mutation_reservations"("user_id", "mutation_id");
DROP INDEX "mutation_reservations_user_id_idx";
CREATE INDEX "sync_changes_user_id_mutation_id_idx" ON "sync_changes"("user_id", "mutation_id");
