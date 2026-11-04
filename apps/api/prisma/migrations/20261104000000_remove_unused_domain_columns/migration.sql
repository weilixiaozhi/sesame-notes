BEGIN;

SET LOCAL lock_timeout = '5s';

-- 成员加入时间与邀请有效期分别由 joined_at 和 expires_at 保存。
ALTER TABLE public.ledger_members DROP COLUMN created_at;
ALTER TABLE public.ledger_invites DROP COLUMN created_at;

-- 分类版本与周期规则使用各自的更新时间和周期业务时间。
ALTER TABLE public.categories DROP COLUMN created_at;
ALTER TABLE public.recurring_transactions DROP COLUMN created_at;

-- 交易和日子以实体修订控制并发，同步事件保存操作设备。
ALTER TABLE public.transactions
  DROP CONSTRAINT transactions_updated_by_device_id_fkey,
  DROP COLUMN updated_by_device_id;
ALTER TABLE public.day_events
  DROP CONSTRAINT day_events_updated_by_device_id_fkey,
  DROP COLUMN updated_by_device_id;

COMMIT;
