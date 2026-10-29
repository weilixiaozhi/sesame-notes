BEGIN;

CREATE TABLE "app_banner_media" (
    "id" VARCHAR(64) NOT NULL,
    "file_name" VARCHAR(200) NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(100),
    CONSTRAINT "app_banner_media_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "app_banner_media_hash_check" CHECK ("id" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "app_banner_media_size_check" CHECK ("byte_size" > 0 AND "byte_size" <= 8388608),
    CONSTRAINT "app_banner_media_dimensions_check" CHECK (
        "width" BETWEEN 1 AND 4096 AND "height" BETWEEN 1 AND 4096
        AND "width"::bigint * "height" <= 16000000
    )
);

CREATE TABLE "app_banners" (
    "slot" VARCHAR(64) NOT NULL,
    "image_id" VARCHAR(64),
    "target" VARCHAR(64) NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" VARCHAR(100),
    CONSTRAINT "app_banners_pkey" PRIMARY KEY ("slot"),
    CONSTRAINT "app_banners_slot_check" CHECK ("slot" IN ('fitness-plan-library', 'fitness-template-library')),
    CONSTRAINT "app_banners_target_check" CHECK ("target" IN (
        'fitness-plan-library', 'fitness-template-library', 'fitness-exercises', 'fitness-plans', 'fitness-templates'
    )),
    CONSTRAINT "app_banners_version_check" CHECK ("version" >= 1),
    CONSTRAINT "app_banners_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "app_banner_media"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "app_banners_image_id_is_enabled_idx" ON "app_banners"("image_id", "is_enabled");

COMMIT;
