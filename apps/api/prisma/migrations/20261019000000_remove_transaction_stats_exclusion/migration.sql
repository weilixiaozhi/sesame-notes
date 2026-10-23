BEGIN;

-- 交易明细和统计统一使用全部有效支出，持久化模型只保存实际记账内容。
ALTER TABLE "transactions" DROP COLUMN "exclude_from_stats";

-- 增量事件和编辑历史保留原有身份、版本与时间，只清理交易载荷中的统计设置。
UPDATE "sync_changes"
SET "payload" = ("payload"::jsonb - 'exclude_from_stats')::json
WHERE "entity_type" = 'transaction' AND "payload"::jsonb ? 'exclude_from_stats';

UPDATE "transaction_edit_history"
SET "changes" = ("changes"::jsonb - 'exclude_from_stats')::jsonb
WHERE "changes"::jsonb ? 'exclude_from_stats';

-- 周期历史只处理明确的发生载荷路径，其他实体的自由内容保持原样。
UPDATE "sync_changes" AS "change"
SET "payload" = jsonb_set(
  "change"."payload"::jsonb,
  '{initial_state,occurrences}',
  (
    SELECT COALESCE(jsonb_agg(
      CASE WHEN jsonb_typeof("occurrence"."value" -> 'payload') = 'object'
        THEN jsonb_set("occurrence"."value", '{payload}', ("occurrence"."value" -> 'payload') - 'exclude_from_stats')
        ELSE "occurrence"."value"
      END ORDER BY "occurrence"."position"
    ), '[]'::jsonb)
    FROM jsonb_array_elements("change"."payload"::jsonb #> '{initial_state,occurrences}')
      WITH ORDINALITY AS "occurrence"("value", "position")
  )
)::json
WHERE "change"."entity_type" = 'recurring_transaction'
  AND jsonb_typeof("change"."payload"::jsonb #> '{initial_state,occurrences}') = 'array';

-- HTTP 幂等回执仅匹配交易响应结构，不修改请求指纹和其他业务响应。
UPDATE "idempotency_keys"
SET "response" = ("response"::jsonb - 'exclude_from_stats')::jsonb
WHERE "response"::jsonb ? 'tx_type'
  AND "response"::jsonb ? 'native_amount'
  AND "response"::jsonb ? 'currency_code'
  AND "response"::jsonb ? 'exclude_from_stats';

COMMIT;
