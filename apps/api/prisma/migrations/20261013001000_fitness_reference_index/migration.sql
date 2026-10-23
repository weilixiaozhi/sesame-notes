BEGIN;

-- 同步事务先取得提交锁，再访问实体行；迁移使用相同顺序阻止回填期间出现并发写入。
SELECT pg_advisory_xact_lock(1936028513, 1);
LOCK TABLE public.fitness_entities IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE "fitness_entity_references" (
  "entity_id" UUID NOT NULL,
  "target_id" UUID NOT NULL,
  CONSTRAINT "fitness_entity_references_pkey" PRIMARY KEY ("entity_id", "target_id"),
  CONSTRAINT "fitness_entity_references_entity_id_fkey"
    FOREIGN KEY ("entity_id") REFERENCES "fitness_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- 来源允许晚到或物理删除；target_id 只建立反向索引，不要求目标实体当前存在。
CREATE INDEX "fitness_entity_references_target_id_entity_id_idx"
  ON "fitness_entity_references"("target_id", "entity_id");

/** 提取原 JSONPath 谓词能匹配的规范 UUID，保留任意嵌套与数组比较语义。 */
CREATE FUNCTION public.fitness_reference_ids(payload JSONB)
RETURNS TABLE(target_id UUID) LANGUAGE sql IMMUTABLE STRICT AS $references$
  WITH candidates AS MATERIALIZED (
    SELECT DISTINCT value #>> '{}' AS id
    FROM jsonb_path_query(payload, 'strict $.** ? (@.type() == "string")') AS candidate(value)
    WHERE value #>> '{}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  )
  SELECT id::uuid FROM candidates
  WHERE jsonb_path_exists(
    payload,
    '$.** ? (@.source_plan_id == $id || @.source_template_id == $id)',
    jsonb_build_object('id', id)
  );
$references$;

INSERT INTO public.fitness_entity_references(entity_id, target_id)
SELECT entity.id, reference.target_id
FROM public.fitness_entities AS entity
CROSS JOIN LATERAL public.fitness_reference_ids(entity.payload) AS reference;

-- 迁移不能把历史非法引用静默固化；源与目标都存在时必须属于相同空间。
DO $validate$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.fitness_entity_references AS reference
    JOIN public.fitness_entities AS source ON source.id = reference.entity_id
    JOIN public.fitness_entities AS target ON target.id = reference.target_id
    WHERE source.fitness_space_id <> target.fitness_space_id
  ) THEN
    RAISE EXCEPTION 'FITNESS_CROSS_SPACE_REFERENCE' USING ERRCODE = '23514';
  END IF;
END
$validate$;

/** 在语句锁定实体行之前取得同步提交锁，直接 SQL 与应用写入遵守同一锁顺序。 */
CREATE FUNCTION public.lock_fitness_reference_write()
RETURNS trigger LANGUAGE plpgsql AS $lock$
BEGIN
  PERFORM pg_advisory_xact_lock(1936028513, 1);
  RETURN NULL;
END
$lock$;

CREATE TRIGGER fitness_reference_write_lock
BEFORE INSERT OR UPDATE OR DELETE ON public.fitness_entities
FOR EACH STATEMENT EXECUTE FUNCTION public.lock_fitness_reference_write();

/** 在实体写入的同一事务中刷新派生引用，所有调用方共用数据库维护入口。 */
CREATE FUNCTION public.refresh_fitness_references()
RETURNS trigger LANGUAGE plpgsql AS $refresh$
BEGIN
  -- 与来源无关的修订、墓碑及运行状态更新不重复解析完全相同的 JSON。
  IF TG_OP = 'UPDATE' AND NEW.payload IS NOT DISTINCT FROM OLD.payload THEN RETURN NEW; END IF;
  DELETE FROM public.fitness_entity_references WHERE entity_id = NEW.id;
  INSERT INTO public.fitness_entity_references(entity_id, target_id)
  SELECT NEW.id, reference.target_id FROM public.fitness_reference_ids(NEW.payload) AS reference;
  RETURN NEW;
END
$refresh$;

CREATE TRIGGER fitness_references_refresh
AFTER INSERT OR UPDATE ON public.fitness_entities
FOR EACH ROW EXECUTE FUNCTION public.refresh_fitness_references();

/** 提交前按来源主键和目标反向索引检查双向关系，允许同事务内完成合法重排。 */
CREATE OR REPLACE FUNCTION public.enforce_fitness_space_references()
RETURNS trigger LANGUAGE plpgsql AS $references$
BEGIN
  -- 延迟触发时读取最终实体状态；同事务已物理删除的实体不再留下待校验关系。
  IF EXISTS (
    SELECT 1 FROM public.fitness_entity_references AS reference
    JOIN public.fitness_entities AS source ON source.id = reference.entity_id
    JOIN public.fitness_entities AS target ON target.id = reference.target_id
    WHERE reference.entity_id = NEW.id AND source.fitness_space_id <> target.fitness_space_id
  ) OR EXISTS (
    SELECT 1 FROM public.fitness_entity_references AS reference
    JOIN public.fitness_entities AS source ON source.id = reference.entity_id
    JOIN public.fitness_entities AS target ON target.id = reference.target_id
    WHERE reference.target_id = NEW.id AND source.fitness_space_id <> target.fitness_space_id
  ) THEN
    RAISE EXCEPTION 'FITNESS_CROSS_SPACE_REFERENCE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$references$;

COMMIT;
