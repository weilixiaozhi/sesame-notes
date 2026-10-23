import { ChevronRight, Trash2 } from 'lucide-react';
import type { components } from '@sesame-notes/api-client';
import { Button } from '../../components/ui';
import { CategoryIcon } from './category-icons';
import { localDate } from './accounting-analytics';
import { displayAmount } from './money';

type Transaction = components['schemas']['Transaction'];
type Category = components['schemas']['Category'];
type DayGroup = { date: string; label: string; weekday: string; items: Transaction[] };

/** 按用户所在时区归组，日期倒序展示；分页未加载的金额不会被误算为全天合计。 */
export function groupTransactionsByDay(items: Transaction[], now = new Date()): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  for (const item of items) {
    let date = 'unknown';
    let label = '日期待确认';
    let weekday = '';
    try {
      const happened = new Date(item.happened_at);
      if (!Number.isFinite(happened.getTime())) throw new Error('支出发生时间不是有效日期');
      date = localDate(happened);
      label =
        date === localDate(now)
          ? '今天'
          : date === localDate(yesterday)
            ? '昨天'
            : new Intl.DateTimeFormat('zh-CN', {
                ...(happened.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}),
                month: 'long',
                day: 'numeric',
              }).format(happened);
      weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(happened);
    } catch (error) {
      console.error('支出记录日期归组失败', { transactionId: item.id, error });
    }
    const group = groups.get(date) ?? { date, label, weekday, items: [] };
    group.items.push(item);
    groups.set(date, group);
  }
  // 同一天的记录保持服务端顺序，避免并列时间的记录在加载下一页时跳动。
  return [...groups.values()].sort((left, right) => {
    if (left.date === 'unknown') return 1;
    if (right.date === 'unknown') return -1;
    return right.date.localeCompare(left.date);
  });
}

/** 安全格式化单笔发生时间，损坏记录仍可被用户识别和编辑。 */
function recordTime(item: Transaction): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(
      new Date(item.happened_at),
    );
  } catch (error) {
    console.error('支出记录时间展示失败', { transactionId: item.id, error });
    return '时间待确认';
  }
}

/** 将账单呈现为按日排列的生活记录，整行打开只读详情，桌面删除保留独立确认入口。 */
export function TransactionTimeline({
  items,
  categories,
  currency,
  archived,
  onOpen,
  onDelete,
}: {
  items: Transaction[];
  categories: Category[];
  currency: string;
  archived: boolean;
  onOpen: (item: Transaction) => void;
  onDelete: (item: Transaction) => void;
}) {
  const groups = groupTransactionsByDay(items);
  return (
    <div className="transaction-timeline">
      {groups.map((group) => (
        <section className="transaction-day" key={group.date} aria-label={`${group.label}的支出`}>
          <div className="transaction-day-heading">
            <h3>{group.label}</h3>
            <span>{group.weekday}</span>
          </div>
          <ul className="transaction-day-list">
            {group.items.map((item) => {
              const categoryIndex = categories.findIndex((entry) => entry.id === item.category_id);
              const category = categories[categoryIndex];
              return (
                <li className="transaction-entry" key={item.id}>
                  <button
                    type="button"
                    className="transaction-entry-content"
                    aria-label={`查看${item.note || item.category_name || '支出'} ${item.amount}`}
                    onClick={() => onOpen(item)}
                  >
                    <span className={`transaction-category-icon record-tone-${Math.max(0, categoryIndex) % 4}`}>
                      <CategoryIcon name={category?.icon ?? null} size={21} />
                    </span>
                    <span className="transaction-entry-description">
                      <strong className="transaction-entry-title">{item.note || item.category_name || '未分类'}</strong>
                      <span className="transaction-entry-meta">
                        <span className="transaction-entry-category-label">{item.category_name ?? '未分类'}</span>
                        <span aria-hidden="true">·</span>
                        <time dateTime={group.date === 'unknown' ? undefined : item.happened_at}>
                          {recordTime(item)}
                        </time>
                        {item.splits.length > 0 && <span className="badge">AA</span>}
                      </span>
                    </span>
                    <span className="transaction-entry-amount">
                      <strong>{displayAmount(item.native_amount)}</strong>
                      <span>
                        {currency}
                        {item.currency_code !== currency
                          ? ` · 原币 ${item.currency_code} ${displayAmount(item.amount)}`
                          : ''}
                      </span>
                    </span>
                    <ChevronRight className="transaction-entry-chevron" size={16} aria-hidden="true" />
                  </button>
                  {!archived && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="transaction-entry-delete"
                      aria-label={`删除${item.note || item.category_name || '支出'} ${item.amount}`}
                      onClick={() => onDelete(item)}
                    >
                      <Trash2 size={16} />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
