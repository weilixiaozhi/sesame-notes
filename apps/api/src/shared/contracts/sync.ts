/** 对外同步实体全集；协议枚举与写入读回门禁共同消费，新增实体必须补齐覆盖。 */
export const SYNC_ENTITY_TYPES = [
  'ledger',
  'ledger_archive',
  'transaction',
  'category',
  'recurring_transaction',
  'exchange_rate_override',
  'member',
  'day_book',
  'day_event',
  'memo_book',
  'memo_entry',
  'fitness_space',
  'fitness_template',
  'fitness_plan',
  'fitness_workout',
  'fitness_preferences',
] as const;
