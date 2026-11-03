BEGIN;

SET LOCAL lock_timeout = '5s';

-- 素材的大小和帧尺寸继续由数据库约束保证，媒体类型由 GIF 上传入口验证。
ALTER TABLE public.official_fitness_media
  DROP CONSTRAINT official_fitness_media_shape_check,
  ADD CONSTRAINT official_fitness_media_shape_check
    CHECK (byte_size > 0 AND width > 0 AND height > 0 AND frames > 0),
  DROP COLUMN mime_type;

-- 邀请有效性、事件统计与后台会话授权均使用各自的正式业务字段。
ALTER TABLE public.ledger_invites DROP COLUMN code_prefix;
ALTER TABLE public.product_analytics_events DROP COLUMN received_at;
ALTER TABLE public.admin_sessions DROP COLUMN user_agent, DROP COLUMN ip, DROP COLUMN created_at;
ALTER TABLE public.mutation_reservations DROP COLUMN created_at;
ALTER TABLE public.admin_accounts DROP COLUMN deleted_by;
ALTER TABLE public.admin_groups DROP COLUMN deleted_by;
ALTER TABLE public.idempotency_keys DROP COLUMN created_at;

COMMIT;
