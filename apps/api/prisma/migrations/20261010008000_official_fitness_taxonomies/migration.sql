CREATE TABLE "official_fitness_taxonomies" (
  "kind" VARCHAR(16) NOT NULL,
  "id" VARCHAR(100) NOT NULL,
  "name_zh" VARCHAR(100) NOT NULL,
  "name_hant" VARCHAR(100) NOT NULL,
  "name_en" VARCHAR(200) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "deleted_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_by" VARCHAR(100),
  CONSTRAINT "official_fitness_taxonomies_pkey" PRIMARY KEY ("kind", "id"),
  CONSTRAINT "official_fitness_taxonomies_kind_check" CHECK ("kind" IN ('body_part', 'equipment')),
  CONSTRAINT "official_fitness_taxonomies_version_check" CHECK ("version" >= 1),
  CONSTRAINT "official_fitness_taxonomies_sort_check" CHECK ("sort_order" >= 0)
);

CREATE INDEX "official_fitness_taxonomies_kind_deleted_at_sort_order_id_idx"
  ON "official_fitness_taxonomies" ("kind", "deleted_at", "sort_order", "id");

-- 内置身份保持与动作正文一致，名称作为可编辑资料独立保存。
INSERT INTO "official_fitness_taxonomies" ("kind", "id", "name_zh", "name_hant", "name_en", "sort_order")
SELECT kind, id, name, name, id, position
FROM (VALUES
  ('body_part', 'back', '背部', 0),
  ('body_part', 'cardio', '有氧', 1),
  ('body_part', 'chest', '胸部', 2),
  ('body_part', 'lower arms', '前臂', 3),
  ('body_part', 'lower legs', '小腿', 4),
  ('body_part', 'neck', '颈部', 5),
  ('body_part', 'shoulders', '肩部', 6),
  ('body_part', 'upper arms', '上臂', 7),
  ('body_part', 'upper legs', '大腿', 8),
  ('body_part', 'waist', '腰腹', 9),
  ('equipment', 'assisted', '辅助器械', 0),
  ('equipment', 'band', '弹力带', 1),
  ('equipment', 'barbell', '杠铃', 2),
  ('equipment', 'body weight', '自重', 3),
  ('equipment', 'bosu ball', '波速球', 4),
  ('equipment', 'cable', '绳索器械', 5),
  ('equipment', 'dumbbell', '哑铃', 6),
  ('equipment', 'elliptical machine', '椭圆机', 7),
  ('equipment', 'ez barbell', '曲杆杠铃', 8),
  ('equipment', 'hammer', '训练锤', 9),
  ('equipment', 'kettlebell', '壶铃', 10),
  ('equipment', 'leverage machine', '杠杆器械', 11),
  ('equipment', 'medicine ball', '药球', 12),
  ('equipment', 'olympic barbell', '奥林匹克杠铃', 13),
  ('equipment', 'resistance band', '阻力带', 14),
  ('equipment', 'roller', '滚轮', 15),
  ('equipment', 'rope', '绳索', 16),
  ('equipment', 'skierg machine', '滑雪机', 17),
  ('equipment', 'sled machine', '雪橇机', 18),
  ('equipment', 'smith machine', '史密斯机', 19),
  ('equipment', 'stability ball', '健身球', 20),
  ('equipment', 'stationary bike', '固定自行车', 21),
  ('equipment', 'stepmill machine', '登阶机', 22),
  ('equipment', 'tire', '轮胎', 23),
  ('equipment', 'trap bar', '六角杠铃', 24),
  ('equipment', 'upper body ergometer', '上肢功率车', 25),
  ('equipment', 'weighted', '负重', 26),
  ('equipment', 'wheel roller', '健腹轮', 27)
) AS defaults(kind, id, name, position);

-- 历史官方正文中的扩展值同样成为有效字典项，包含停用动作和训练模板。
WITH referenced AS (
  SELECT 'body_part' AS kind, content->>'body_part' AS id
    FROM official_fitness_content WHERE kind = 'exercise'
  UNION
  SELECT 'equipment', content->>'equipment'
    FROM official_fitness_content WHERE kind = 'exercise'
  UNION
  SELECT 'equipment', equipment.id
    FROM official_fitness_content c
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(c.content->'equipment') = 'array' THEN c.content->'equipment' ELSE '[]'::jsonb END
    ) AS equipment(id)
    WHERE c.kind = 'template'
)
INSERT INTO official_fitness_taxonomies (kind, id, name_zh, name_hant, name_en, sort_order)
SELECT kind, id, id, id, id, 1000 FROM referenced
WHERE id IS NOT NULL AND btrim(id) <> '' AND char_length(id) <= 100
ON CONFLICT (kind, id) DO NOTHING;

-- 字典加入公开目录后一起推进缓存版本，客户端可以发现新的名称数据。
INSERT INTO official_fitness_state (id, content_version) VALUES (1, 2)
ON CONFLICT (id) DO UPDATE SET content_version = official_fitness_state.content_version + 1;
