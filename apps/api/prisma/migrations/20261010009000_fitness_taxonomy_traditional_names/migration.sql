BEGIN;

-- 与后台分类写操作共用事务锁，名称修正与管理员编辑不能交错提交。
SELECT pg_advisory_xact_lock(1973108041::bigint);

WITH translations(kind, id, original_name, traditional_name) AS (
  VALUES
    ('body_part', 'back', '背部', '背部'),
    ('body_part', 'cardio', '有氧', '有氧'),
    ('body_part', 'chest', '胸部', '胸部'),
    ('body_part', 'lower arms', '前臂', '前臂'),
    ('body_part', 'lower legs', '小腿', '小腿'),
    ('body_part', 'neck', '颈部', '頸部'),
    ('body_part', 'shoulders', '肩部', '肩部'),
    ('body_part', 'upper arms', '上臂', '上臂'),
    ('body_part', 'upper legs', '大腿', '大腿'),
    ('body_part', 'waist', '腰腹', '腰腹'),
    ('equipment', 'assisted', '辅助器械', '輔助器械'),
    ('equipment', 'band', '弹力带', '彈力帶'),
    ('equipment', 'barbell', '杠铃', '槓鈴'),
    ('equipment', 'body weight', '自重', '自重'),
    ('equipment', 'bosu ball', '波速球', '半球平衡球'),
    ('equipment', 'cable', '绳索器械', '滑輪器材'),
    ('equipment', 'dumbbell', '哑铃', '啞鈴'),
    ('equipment', 'elliptical machine', '椭圆机', '橢圓機'),
    ('equipment', 'ez barbell', '曲杆杠铃', '曲桿槓鈴'),
    ('equipment', 'hammer', '训练锤', '錘子'),
    ('equipment', 'kettlebell', '壶铃', '壺鈴'),
    ('equipment', 'leverage machine', '杠杆器械', '固定器材'),
    ('equipment', 'medicine ball', '药球', '藥球'),
    ('equipment', 'olympic barbell', '奥林匹克杠铃', '奧林匹克槓鈴'),
    ('equipment', 'resistance band', '阻力带', '阻力帶'),
    ('equipment', 'roller', '滚轮', '泡沫軸'),
    ('equipment', 'rope', '绳索', '繩索'),
    ('equipment', 'skierg machine', '滑雪机', '滑雪訓練機'),
    ('equipment', 'sled machine', '雪橇机', '腿推器材'),
    ('equipment', 'smith machine', '史密斯机', '史密斯機'),
    ('equipment', 'stability ball', '健身球', '健身球'),
    ('equipment', 'stationary bike', '固定自行车', '健身單車'),
    ('equipment', 'stepmill machine', '登阶机', '登階機'),
    ('equipment', 'tire', '轮胎', '輪胎'),
    ('equipment', 'trap bar', '六角杠铃', '六角槓鈴'),
    ('equipment', 'upper body ergometer', '上肢功率车', '上肢功率車'),
    ('equipment', 'weighted', '负重', '負重器材'),
    ('equipment', 'wheel roller', '健腹轮', '健腹輪')
), corrected AS (
  UPDATE official_fitness_taxonomies AS taxon
  SET name_hant = translations.traditional_name,
      version = taxon.version + 1,
      updated_at = CURRENT_TIMESTAMP
  FROM translations
  WHERE taxon.kind = translations.kind
    AND taxon.id = translations.id
    -- 仅接受未被编辑、删除且仍保留完整种子名称的记录，保护管理员已确认的名称。
    AND taxon.version = 1
    AND taxon.updated_by IS NULL
    AND taxon.deleted_at IS NULL
    AND taxon.name_zh = translations.original_name
    AND taxon.name_hant = translations.original_name
    AND taxon.name_en = translations.id
    AND taxon.name_hant IS DISTINCT FROM translations.traditional_name
  RETURNING taxon.id
)
-- 名称与缓存版本在同一事务提交；没有实际修正时不产生无意义的新版本。
INSERT INTO official_fitness_state (id, content_version)
SELECT 1, 2 WHERE EXISTS (SELECT 1 FROM corrected)
ON CONFLICT (id) DO UPDATE SET content_version = official_fitness_state.content_version + 1;

COMMIT;
