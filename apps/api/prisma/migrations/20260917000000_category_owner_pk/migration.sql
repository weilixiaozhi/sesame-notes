-- 分类身份从全局唯一收敛为按所有者唯一。
--
-- 客户端默认分类 id 由固定模板确定性派生（uuid v5），任何账号派生出的都是同一批
-- id；此前 id 为全局主键，第二个账号推送同 id 分类会被判 409 ENTITY_SCOPE_CONFLICT，
-- 其交易因「分类不存在」被逐条拒绝。改为 (id, owner_id) 复合主键后，各账号各自持有
-- 同一批分类身份，交易引用仍按 (category_id, owner_id) 复合外键校验。
ALTER TABLE "categories" DROP CONSTRAINT "categories_pkey";
ALTER TABLE "categories" ADD CONSTRAINT "categories_pkey" PRIMARY KEY ("id", "owner_id");
