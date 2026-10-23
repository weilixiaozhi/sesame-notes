BEGIN;

/** 只从任意层级的来源字段提取候选，其他实体与训练组标识不参与重复谓词求值。 */
CREATE OR REPLACE FUNCTION public.fitness_reference_ids(payload JSONB)
RETURNS TABLE(target_id UUID) LANGUAGE sql IMMUTABLE STRICT AS $references$
  WITH source_values AS (
    SELECT source.value
    FROM jsonb_path_query(payload, 'strict $.** ? (@.type() == "object")') AS object(value)
    CROSS JOIN LATERAL (VALUES (object.value->'source_plan_id'), (object.value->'source_template_id')) AS source(value)
    WHERE source.value IS NOT NULL
  ), candidates AS MATERIALIZED (
    -- 来源值可为嵌套数组或其他 JSON；最终仍由原谓词决定能否匹配，不能把字符串枚举视为引用。
    SELECT DISTINCT candidate.value #>> '{}' AS id
    FROM source_values AS source
    CROSS JOIN LATERAL jsonb_path_query(source.value, 'strict $.** ? (@.type() == "string")') AS candidate(value)
    WHERE candidate.value #>> '{}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  )
  SELECT id::uuid FROM candidates
  WHERE jsonb_path_exists(
    payload,
    '$.** ? (@.source_plan_id == $id || @.source_template_id == $id)',
    jsonb_build_object('id', id)
  );
$references$;

COMMIT;
