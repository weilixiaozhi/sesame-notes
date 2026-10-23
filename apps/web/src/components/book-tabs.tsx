import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import './book-tabs.css';

type BookTab = { id: string; name: string; archived?: boolean };

/** 以本子名称直接切换内容；选择状态由页面控制，未保存草稿可拦截路由变化。 */
export function BookTabs({
  label,
  items,
  value,
  onSelect,
  disabled = false,
}: {
  label: string;
  items: readonly BookTab[];
  value?: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const strip = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  // 目录刷新可能生成新数组；只有实际页签内容变化时才重新定位，保留用户手动浏览的位置。
  const tabLayoutKey = JSON.stringify(items.map(({ id, name, archived }) => [id, name, Boolean(archived)]));
  useEffect(() => {
    try {
      const container = strip.current;
      const active = value ? buttons.current.get(value) : undefined;
      if (!container || !active || container.clientWidth === 0) return;
      const bounds = container.getBoundingClientRect();
      const target = active.getBoundingClientRect();
      // 深链和新建本子只调整页签内部的横向位置，不改变用户正在浏览的页面高度。
      if (target.left < bounds.left) container.scrollLeft += target.left - bounds.left;
      else if (target.right > bounds.right) container.scrollLeft += target.right - bounds.right;
    } catch (cause) {
      console.error('定位当前本子页签失败', { label, value, cause });
    }
  }, [value, tabLayoutKey, label]);

  /** 左右键与首尾键只移动焦点，用户按回车或空格后才请求切本。 */
  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (disabled || !items.length) return;
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % items.length
        : event.key === 'ArrowLeft'
          ? (index - 1 + items.length) % items.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    try {
      buttons.current.get(items[next]!.id)?.focus();
    } catch (cause) {
      console.error('移动本子页签焦点失败', { label, bookId: items[next]?.id, cause });
    }
  }

  /** 仅转交目标身份，不提前变更高亮或销毁当前内容和草稿。 */
  function select(id: string) {
    try {
      if (disabled || id === value) return;
      onSelect(id);
      setError('');
    } catch (cause) {
      console.error('切换本子失败', { label, currentId: value, requestedId: id, cause });
      setError('暂时无法切换本子，请重试。');
    }
  }

  return (
    <div className="book-tabs-container">
      <div className="book-tabs" role="group" aria-label={label} ref={strip}>
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            className="book-tab"
            ref={(button) => {
              if (button) buttons.current.set(item.id, button);
              else buttons.current.delete(item.id);
            }}
            aria-pressed={item.id === value}
            aria-label={item.archived ? `${item.name}（已归档）` : item.name}
            title={item.name}
            disabled={disabled}
            onKeyDown={(event) => moveFocus(event, index)}
            onClick={() => select(item.id)}
          >
            <span>{item.name}</span>
            {item.archived && <small>已归档</small>}
          </button>
        ))}
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
