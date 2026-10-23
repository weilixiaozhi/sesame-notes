BEGIN;

-- 正文仅保留动作名称与教学资料，行版本和其余字段保持原值。
WITH cleaned AS (
  UPDATE "official_fitness_content"
  SET "content" = "content" - 'aliases'
  WHERE "kind" = 'exercise' AND "content" ? 'aliases'
  RETURNING "id"
)
UPDATE "official_fitness_state"
SET "content_version" = "content_version" + 1
WHERE "id" = 1 AND EXISTS (SELECT 1 FROM cleaned);

ALTER TABLE "official_fitness_content"
  ADD CONSTRAINT "official_fitness_content_exercise_fields_check" CHECK (
    "kind" <> 'exercise' OR NOT ("content" ? 'aliases')
  );

COMMIT;
