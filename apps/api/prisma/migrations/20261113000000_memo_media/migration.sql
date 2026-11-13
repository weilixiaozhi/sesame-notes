BEGIN;

SET LOCAL lock_timeout = '5s';

-- 备忘录正文只保存媒体标识；图片字节与像素信息按账号隔离，注销账号时随外键删除。
CREATE TABLE public.memo_media (
  id uuid NOT NULL,
  owner_id uuid NOT NULL,
  file_name character varying(128) NOT NULL,
  byte_size integer NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  sha256 character varying(64) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT memo_media_pkey PRIMARY KEY (id),
  CONSTRAINT memo_media_byte_size_check CHECK (byte_size > 0),
  CONSTRAINT memo_media_dimensions_check CHECK (width > 0 AND height > 0),
  CONSTRAINT memo_media_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT memo_media_file_name_check CHECK (file_name ~ '^[0-9a-f-]{36}\.(png|jpg|webp)$'),
  CONSTRAINT memo_media_owner_id_fkey
    FOREIGN KEY (owner_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX memo_media_owner_id_created_at_idx ON public.memo_media USING btree (owner_id, created_at);

COMMIT;
