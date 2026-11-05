BEGIN;

SET LOCAL lock_timeout = '5s';

-- 新增意图、实体和审计由同一管理员事务提交；回执不按时间清理，保证迟到重试不会再建实体。
CREATE TABLE public.admin_creation_receipts (
  admin_id uuid NOT NULL,
  key uuid NOT NULL,
  request_hash character varying(255) NOT NULL,
  response jsonb NOT NULL,
  CONSTRAINT admin_creation_receipts_pkey PRIMARY KEY (admin_id, key),
  CONSTRAINT admin_creation_receipts_hash_check CHECK (length(request_hash) > 0),
  CONSTRAINT admin_creation_receipts_response_check CHECK (jsonb_typeof(response) = 'object'),
  CONSTRAINT admin_creation_receipts_admin_id_fkey
    FOREIGN KEY (admin_id) REFERENCES public.admin_accounts(id) ON UPDATE CASCADE ON DELETE CASCADE
);

COMMIT;
