import { buildDefinition, intervalTarget, nextOccurrence, type DayEvent } from './day-dates';

const categoryOrder: DayEvent['category'][] = ['birthday', 'anniversary', 'countdown', 'stage'];

type DayEventGroup = { category: DayEvent['category']; events: DayEvent[] };

type SortableDayEvent = {
  event: DayEvent;
  next: string | null;
  target: string | null;
  start: string | null;
};

/** 使用与设备语言无关的字符顺序比较日期和实体 ID。 */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 同日记录按创建时间和实体 ID 排列，接口返回顺序变化不会造成跳动。 */
function stableOrder(left: DayEvent, right: DayEvent): number {
  const created = Date.parse(left.created_at) - Date.parse(right.created_at);
  return (
    (Number.isFinite(created) ? created : compareText(left.created_at, right.created_at)) ||
    compareText(left.id, right.id)
  );
}

/** 每条记录只计算一次日期键，比较器只读取结果，不重复转换农历。 */
function sortableEvent(event: DayEvent, today: string): SortableDayEvent {
  if (!categoryOrder.includes(event.category)) throw new Error('日子类型无效');
  if (event.category === 'birthday' || event.category === 'anniversary') {
    return { event, next: nextOccurrence(event, today), target: null, start: null };
  }
  const definition = buildDefinition(event);
  if (event.category === 'stage') {
    return { event, next: null, target: null, start: definition.start!.solar_date };
  }
  const target =
    definition.event?.solar_date ?? intervalTarget(definition.start!.solar_date, definition.interval_days!);
  return { event, next: target >= today ? target : null, target, start: null };
}

/** 同类按下一次日期排序；阶段按开始日倒序，过期倒数排在未到期记录之后。 */
function compareEvents(left: SortableDayEvent, right: SortableDayEvent): number {
  if (left.event.category === 'stage') {
    return compareText(right.start!, left.start!) || stableOrder(left.event, right.event);
  }
  if (left.next !== null || right.next !== null) {
    if (left.next === null) return 1;
    if (right.next === null) return -1;
    return compareText(left.next, right.next) || stableOrder(left.event, right.event);
  }
  if (left.event.category === 'countdown') {
    return compareText(right.target!, left.target!) || stableOrder(left.event, right.event);
  }
  return stableOrder(left.event, right.event);
}

/** 当前本按固定类型分组并全局排序，损坏日期保留在待确认列表供用户修正。 */
export function groupDayEvents(
  events: readonly DayEvent[],
  today: string,
  bookId: string,
): { groups: DayEventGroup[]; invalid: DayEvent[] } {
  const categories = new Map(categoryOrder.map((category) => [category, [] as SortableDayEvent[]]));
  const invalid: DayEvent[] = [];
  for (const event of events) {
    if (event.day_book_id !== bookId || event.deleted_at !== null) continue;
    try {
      const row = sortableEvent(event, today);
      categories.get(event.category)!.push(row);
    } catch (error) {
      // 日志只保留定位记录所需的 ID 和错误类型，避免暴露名称及原始日期。
      console.error('计算日子排序失败', {
        eventId: event.id,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      invalid.push(event);
    }
  }
  const groups = categoryOrder.flatMap((category) => {
    const rows = categories.get(category)!;
    if (rows.length === 0) return [];
    rows.sort(compareEvents);
    return [{ category, events: rows.map((row) => row.event) }];
  });
  invalid.sort(stableOrder);
  return { groups, invalid };
}
