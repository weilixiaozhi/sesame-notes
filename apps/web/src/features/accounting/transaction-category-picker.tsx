import { useEffect, useId, useRef, useState, type Ref } from 'react';
import { MoreVertical } from 'lucide-react';
import type { components } from '@sesame-notes/api-client';
import { CategoryIcon } from './category-icons';
import './transaction-category-picker.css';

type Category = components['schemas']['Category'];

/** 用五列图标呈现分类，在选中父项所在行下方展开子项，父项本身也可作为记账分类。 */
export function TransactionCategoryPicker({
  categories,
  value,
  onChange,
  onBlur,
  triggerRef,
  disabled,
  hint,
  error,
}: {
  categories: Category[];
  value: string;
  onChange: (id: string) => void;
  onBlur: () => void;
  triggerRef: Ref<HTMLButtonElement>;
  disabled: boolean;
  hint?: string;
  error?: string;
}) {
  const id = useId();
  const pickerRef = useRef<HTMLFieldSetElement>(null);
  const [selectionError, setSelectionError] = useState('');
  const available = categories.filter((category) => category.deleted_at === null);
  const parents = available.filter((category) => category.level === 1 && category.parent_id === null);
  const parentIds = new Set(parents.map((category) => category.id));
  // 历史分类的父项缺失时仍提供入口，避免有效子分类从选择器中消失。
  const roots = available.filter((category) => parentIds.has(category.id) || !parentIds.has(category.parent_id ?? ''));
  const selected = available.find((category) => category.id === value);
  const selectedParent = available.find((category) => category.id === selected?.parent_id);
  const expandedId = selectedParent?.id ?? selected?.id;
  const selectedPath = selected ? [selectedParent?.name, selected.name].filter(Boolean).join(' / ') : '请选择分类';
  const rows = Array.from({ length: Math.ceil(roots.length / 5) }, (_, index) => roots.slice(index * 5, index * 5 + 5));
  const failure = error || selectionError;
  const describedBy = [hint ? `${id}-hint` : '', failure ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;

  useEffect(() => {
    try {
      if (disabled) return;
      const selectedButton = pickerRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
      // 选择父项后展示整张子分类卡；编辑子项时直接定位到已选按钮，兼顾分类区和弹层的滚动。
      const target =
        selectedButton?.getAttribute('aria-expanded') === 'true'
          ? pickerRef.current?.querySelector<HTMLElement>('.transaction-subcategory-panel')
          : selectedButton;
      target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    } catch (cause) {
      console.warn('定位已选支出分类失败，可在分类区域滑动查找', { categoryId: value, cause });
    }
  }, [value, categories, disabled]);

  /** 只更新仍有效的分类，失败时保留现有选择并在分类区域给出可重试的提示。 */
  function choose(category: Category) {
    try {
      if (disabled || !available.some((item) => item.id === category.id)) return;
      onChange(category.id);
      onBlur();
      setSelectionError('');
    } catch (cause) {
      console.error('选择支出分类失败', { categoryId: category.id, cause });
      setSelectionError('暂时无法选择分类，请再点一次。');
    }
  }

  return (
    <fieldset
      ref={pickerRef}
      className="transaction-category-picker"
      disabled={disabled}
      aria-describedby={describedBy}
    >
      <legend className="sr-only">分类</legend>
      <p className="sr-only" role="status">
        {selected ? `已选：${selectedPath}` : selectedPath}
      </p>
      <div className="transaction-category-rows">
        {rows.map((row, rowIndex) => {
          const expanded = row.find((category) => category.id === expandedId);
          const children = expanded ? available.filter((category) => category.parent_id === expanded.id) : [];
          return (
            <div className="transaction-category-row" key={row[0]!.id}>
              <div className="transaction-category-grid">
                {row.map((category, index) => {
                  const hasChildren = available.some((item) => item.parent_id === category.id);
                  return (
                    <button
                      key={category.id}
                      ref={rowIndex === 0 && index === 0 ? triggerRef : undefined}
                      type="button"
                      className="transaction-category-choice"
                      aria-label={`选择分类 ${category.name}`}
                      aria-pressed={value === category.id}
                      aria-expanded={hasChildren ? expandedId === category.id : undefined}
                      aria-controls={hasChildren && expandedId === category.id ? `${id}-children` : undefined}
                      title={category.name}
                      aria-describedby={describedBy}
                      aria-invalid={Boolean(error)}
                      onClick={() => choose(category)}
                    >
                      <span className="transaction-category-symbol">
                        <CategoryIcon name={category.icon} size={20} />
                        {hasChildren && (
                          <span className="transaction-category-badge">
                            <MoreVertical size={10} aria-hidden="true" />
                          </span>
                        )}
                      </span>
                      <span className="transaction-category-name">{category.name}</span>
                    </button>
                  );
                })}
              </div>
              {expanded && children.length > 0 && (
                <div className="transaction-subcategory-panel" id={`${id}-children`}>
                  <p>{expanded.name}</p>
                  <div className="transaction-category-grid" role="group" aria-label={`${expanded.name}的子分类`}>
                    {children.map((category) => (
                      <button
                        key={category.id}
                        type="button"
                        className="transaction-category-choice"
                        aria-label={`选择分类 ${expanded.name} / ${category.name}`}
                        aria-pressed={value === category.id}
                        title={`${expanded.name} / ${category.name}`}
                        onClick={() => choose(category)}
                      >
                        <span className="transaction-category-symbol">
                          <CategoryIcon name={category.icon} size={18} />
                        </span>
                        <span className="transaction-category-name">{category.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {hint && (
        <p id={`${id}-hint`} className="field-hint">
          {hint}
        </p>
      )}
      {failure && (
        <p id={`${id}-error`} className="field-error" role="alert">
          {failure}
        </p>
      )}
    </fieldset>
  );
}
