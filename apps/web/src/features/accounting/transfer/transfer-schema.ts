import type { components, operations } from '@sesame-notes/api-client';

export type Ledger = components['schemas']['Ledger'];
export type Snapshot = operations['getSyncFull']['responses'][200]['content']['application/json'];

export const transferFields = [
  ['date', '日期 / 时间', ['日期', '时间', '交易时间', 'happened_at', 'date']],
  ['amount', '金额', ['金额', 'amount']],
  ['type', '类型', ['类型', 'type', 'tx_type']],
  ['currency', '币种', ['币种', 'currency', 'currency_code']],
  ['category', '分类', ['分类', 'category', 'category_name']],
  ['sub_category', '子分类', ['子分类', '二级分类', 'sub_category']],
  ['category_icon', '分类图标', ['分类图标', 'category_icon']],
  ['sub_category_icon', '子分类图标', ['子分类图标', '二级分类图标', 'sub_category_icon']],
  ['category_scope', '分类来源目录', ['分类来源目录', 'category_scope', 'categoryscope']],
  ['category_id', '分类标识', ['分类标识', 'category_id', 'categoryid']],
  ['parent_category_id', '父分类标识', ['父分类标识', 'parent_category_id', 'parentcategoryid']],
  ['note', '备注', ['备注', 'note', 'remark']],
  ['native_amount', '折算金额', ['折算金额', 'native_amount']],
  ['rate', '原币对本位币汇率', ['汇率', 'rate']],
] as const;

export type TransferKey = (typeof transferFields)[number][0];
export type TransferMapping = Record<TransferKey, string>;
