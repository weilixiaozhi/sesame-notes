import type { MemoEntry } from './memo-content';

type CredentialOrderChange = { entry: MemoEntry; orderKey: string };
const MAX_ORDER_KEY = 9223372036854775807n;

/** 严格读取非负 64 位顺序键，避免浮点精度损失或无效值参与排序。 */
function credentialOrderKey(entry: MemoEntry): bigint {
  if (
    entry.book_type !== 'credentials' ||
    entry.body_format !== 'fields_v1' ||
    entry.deleted_at !== null ||
    entry.order_key === null ||
    !/^(?:0|[1-9]\d*)$/.test(entry.order_key)
  ) {
    throw new Error('有卡片的顺序数据需要确认，请重新加载后再调整。');
  }
  const key = BigInt(entry.order_key);
  if (key > MAX_ORDER_KEY) throw new Error('有卡片的顺序数据需要确认，请重新加载后再调整。');
  return key;
}

/** 新卡片追加在完整本子末尾，整数键不依赖设备时间，也不经过浮点数转换。 */
export function nextCredentialOrderKey(entries: readonly MemoEntry[]): string {
  let maximum = -1n;
  for (const entry of entries) {
    const key = credentialOrderKey(entry);
    if (key > maximum) maximum = key;
  }
  if (maximum === MAX_ORDER_KEY) throw new Error('卡片顺序编号已达上限，暂时无法新建，当前草稿已保留。');
  return (maximum + 1n).toString();
}

/** 搜索子集只替换其在全量快照中的原有位置，隐藏卡片的身份和相对顺序保持完整。 */
export function mergeCredentialOrder(
  entries: readonly MemoEntry[],
  visibleIds: readonly string[],
  ids: readonly string[],
): string[] {
  const fullIds = new Set(entries.map((entry) => entry.id));
  const visible = new Set(visibleIds);
  if (
    fullIds.size !== entries.length ||
    visible.size !== visibleIds.length ||
    ids.length !== visibleIds.length ||
    new Set(ids).size !== ids.length ||
    visibleIds.some((id) => !fullIds.has(id)) ||
    ids.some((id) => !visible.has(id))
  )
    throw new Error('卡片范围已变化，请重新加载后再调整。');
  let next = 0;
  return entries.map((entry) => (visible.has(entry.id) ? ids[next++]! : entry.id));
}

/** 按完整草稿顺序生成唯一整数键，只提交实际发生变化的卡片。 */
export function credentialReorderPlan(entries: readonly MemoEntry[], ids: readonly string[]): CredentialOrderChange[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  if (
    byId.size !== entries.length ||
    ids.length !== entries.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !byId.has(id))
  ) {
    throw new Error('卡片范围已变化，请重新加载后再调整。');
  }
  for (const entry of entries) credentialOrderKey(entry);
  // 使用 BigInt 连续编号，使超出 Number 精度的原始键和重复原始键都能得到唯一结果。
  return ids.flatMap((id, index) => {
    const entry = byId.get(id)!;
    const orderKey = BigInt(index).toString();
    return entry.order_key === orderKey ? [] : [{ entry, orderKey }];
  });
}

/** 鼠标、触屏和键盘共用稳定身份移动，原数组保持不变。 */
export function moveCredential(ids: readonly string[], id: string, index: number): string[] {
  const current = ids.indexOf(id);
  if (current < 0 || index < 0 || index >= ids.length || current === index) return [...ids];
  const next = ids.filter((value) => value !== id);
  next.splice(index, 0, id);
  return next;
}
