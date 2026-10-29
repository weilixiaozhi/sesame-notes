import { useEffect, useRef, useState } from 'react';
import { ChevronRight, MoreVertical } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { ApiError, unwrap, type components } from '@sesame-notes/api-client';
import { captureSessionOperation, queryClient } from '../../lib/session';
import { useDraftClose } from '../../components/use-draft-close';
import { useProductAnalyticsPage } from '../../lib/use-product-analytics';
import { Button, Dialog, ErrorState } from '../../components/ui';
import { CategoryIcon } from './category-icons';
import {
  CategoryTemplateTargetUnavailableError,
  selectedTemplateKeys,
  templatePlan,
  unifiedCategoryTemplates,
} from './category-template-plan';
import './transaction-category-picker.css';
import './category-templates.css';

type Category = components['schemas']['Category'];
const items = unifiedCategoryTemplates();
const parents = items.filter((item) => item.parentKey === null);

/** 模板只保存本次选择；新建分类组与明确追加到已有父项使用独立操作模式。 */
export function CategoryTemplates({
  ledgerId,
  accountId,
  categories,
  onClose,
}: {
  ledgerId: string;
  accountId: string;
  categories: Category[];
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'new' | 'attach'>('new');
  const [targetParentId, setTargetParentId] = useState('');
  const [selected, setSelected] = useState(new Set<string>());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);
  const [pendingTargetId, setPendingTargetId] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [verified, setVerified] = useState<{ source: Category[]; rows: Category[] } | null>(null);
  const [grid, setGrid] = useState<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState(4);
  const lifecycle = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const attempt = useRef<{ key: string; body: ReturnType<typeof templatePlan>; sent: boolean } | null>(null);
  useProductAnalyticsPage('accounting.categories.templates.flat', true, 3);
  const wanted = selectedTemplateKeys(items, selected, mode === 'attach');
  const currentCategories = verified?.source === categories ? verified.rows : categories;
  const targets = currentCategories.filter((row) => row.parent_id === null && !row.deleted_at);
  const target = targets.find((row) => row.id === targetParentId);

  useEffect(() => {
    const active = new AbortController();
    lifecycle.current = active;
    attempt.current = null;
    submitting.current = false;
    setSelected(new Set());
    setTargetParentId('');
    setPendingTargetId('');
    setTargetPickerOpen(false);
    setUncertain(false);
    setVerified(null);
    return () => active.abort();
  }, [accountId, ledgerId]);

  useEffect(() => {
    const container = grid;
    if (!container) return;
    let observer: ResizeObserver | undefined;
    /** 网格列数和逻辑分行共用同一测量结果，字体放大时同步减少列数。 */
    function measureColumns() {
      try {
        if (!container) return;
        const width = container.getBoundingClientRect().width;
        if (width <= 0) return;
        const style = window.getComputedStyle(container);
        const font = Number.parseFloat(style.fontSize) || 16;
        const gap = Number.parseFloat(style.columnGap) || 8;
        const next = Math.max(1, Math.min(6, Math.floor((width + gap) / (font * 5.5 + gap))));
        setColumns((previous) => (previous === next ? previous : next));
      } catch (error) {
        console.error('[category-templates] 计算模板网格布局失败', error);
      }
    }
    try {
      measureColumns();
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(measureColumns);
        observer.observe(container);
      }
      window.addEventListener('resize', measureColumns);
    } catch (error) {
      console.error('[category-templates] 监听模板网格布局失败', error);
    }
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measureColumns);
    };
  }, [grid]);

  const save = useMutation({
    mutationFn: async (active: AbortController) => {
      try {
        const operation = captureSessionOperation(accountId);
        const signal = AbortSignal.any([active.signal, operation.signal]);
        signal.throwIfAborted();
        if (!attempt.current) {
          let current = currentCategories;
          if (mode === 'attach') {
            // 重新核验明确目标的归属与层级，不按同名选择替代目标。
            current = unwrap(
              await operation.client.GET('/api/v1/ledgers/{ledger_id}/categories', {
                signal,
                params: { path: { ledger_id: ledgerId } },
              }),
            );
            operation.assertCurrent();
            signal.throwIfAborted();
            if (lifecycle.current !== active) throw new DOMException('分类页面已变化', 'AbortError');
            setVerified({ source: categories, rows: current });
          }
          attempt.current = {
            key: crypto.randomUUID(),
            body: templatePlan(items, selected, current, mode === 'attach' ? { targetParentId } : {}),
            sent: false,
          };
        }
        const command = attempt.current;
        if (!command.body.length) throw new Error('请先选择要添加的分类');
        command.sent = true;
        unwrap(
          await operation.client.POST('/api/v1/ledgers/{ledger_id}/categories/add-batch', {
            signal,
            params: { path: { ledger_id: ledgerId }, header: { 'idempotency-key': command.key } },
            body: { items: command.body },
          }),
        );
        operation.assertCurrent();
        signal.throwIfAborted();
        return { signal, active };
      } catch (error) {
        if (!active.signal.aborted) console.error('[category-templates] 添加分类失败', error);
        throw error;
      }
    },
    onSuccess: completeSave,
    onError: (error, active) => {
      if (
        active.signal.aborted ||
        lifecycle.current !== active ||
        (error instanceof Error && error.name === 'AbortError')
      )
        return;
      const rejected =
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429;
      if (rejected || !attempt.current?.sent) {
        attempt.current = null;
        setUncertain(false);
      } else setUncertain(true);
      const targetUnavailable =
        error instanceof CategoryTemplateTargetUnavailableError ||
        (error instanceof ApiError && error.code === 'CATEGORY_PARENT_UNAVAILABLE');
      if (targetUnavailable) {
        setTargetParentId('');
        setPendingTargetId('');
        // 服务端在最终提交时也可能发现目标已变化；失效项立即移出本次候选。
        setVerified((previous) => ({
          source: categories,
          rows: (previous?.source === categories ? previous.rows : currentCategories).filter(
            (row) => row.id !== targetParentId,
          ),
        }));
        void queryClient.invalidateQueries({ queryKey: ['account', accountId, 'accounting'] }).catch((refreshError) => {
          console.error('[category-templates] 刷新失效分类目标失败', refreshError);
        });
      }
    },
    onSettled: (_data, _error, active) => {
      if (lifecycle.current === active) submitting.current = false;
    },
  });
  const locked = save.isPending || uncertain;
  const { close, confirmation, finish } = useDraftClose(selected.size > 0, locked, onClose);

  /** 完成后刷新当前账号目录，过期会话的响应不得更新其他账号界面。 */
  async function completeSave({ signal, active }: { signal: AbortSignal; active: AbortController }) {
    try {
      if (signal.aborted || lifecycle.current !== active) return;
      await queryClient.invalidateQueries({ queryKey: ['account', accountId] });
      if (signal.aborted || lifecycle.current !== active) return;
      attempt.current = null;
      setUncertain(false);
      finish();
    } catch (error) {
      console.error('[category-templates] 刷新分类目录失败', error);
      throw error;
    }
  }
  /** 切换操作清空本次选择，避免把新建父项的意图带入已有父项。 */
  function changeMode(next: 'new' | 'attach') {
    if (locked || mode === next) return;
    setMode(next);
    setExpandedId(null);
    setSelected(new Set());
    setTargetPickerOpen(false);
    save.reset();
  }

  /** 勾选只修改当前草稿，不读取或修改已有分类。 */
  function toggle(key: string) {
    if (locked) return;
    setSelected((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  /** 取消父项同时取消依赖的子项；单独取消子项仍保留用户明确选择的父项。 */
  function toggleParent(key: string) {
    if (locked) return;
    setExpandedId(items.some((child) => child.parentKey === key) ? key : null);
    if (mode === 'attach' || !wanted.has(key)) {
      toggle(key);
      return;
    }
    setSelected((previous) => {
      const next = new Set(previous);
      next.delete(key);
      for (const child of items) if (child.parentKey === key) next.delete(child.key);
      return next;
    });
  }

  /** 全选仅作用于本次草稿，追加模式的每个节点都独立加入明确目标。 */
  function toggleAll() {
    if (locked) return;
    setSelected(wanted.size === items.length ? new Set() : new Set(items.map((item) => item.key)));
  }

  /** 弹层单独保存候选，用户确认后才替换已指定的目标身份。 */
  function openTargetPicker() {
    if (locked) return;
    setPendingTargetId(targetParentId);
    setTargetPickerOpen(true);
  }

  /** 卡片保持同一密度，关联信息仅在新建模式的独立展开区呈现。 */
  function choice(
    item: (typeof items)[number],
    checked: boolean,
    label: string,
    onChange: () => void,
    hasChildren = false,
  ) {
    return (
      <label className="category-template-card-choice">
        <input
          type="checkbox"
          aria-label={label}
          disabled={locked}
          checked={checked}
          onChange={onChange}
          aria-expanded={hasChildren ? expandedId === item.key : undefined}
        />
        <span className="transaction-category-symbol category-template-icon">
          <CategoryIcon name={item.icon} size={20} />
          {hasChildren && (
            <span className="transaction-category-badge" aria-hidden>
              <MoreVertical size={10} />
            </span>
          )}
        </span>
        <span className="transaction-category-name category-template-name">{item.name}</span>
      </label>
    );
  }

  const columnStyle = { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` };
  const footer = (
    <div className="category-template-footer">
      <span role="status">已选 {wanted.size} 项</span>
      <Button variant="ghost" disabled={locked} onClick={toggleAll}>
        {wanted.size === items.length ? '取消全选' : '全选'}
      </Button>
      <Button
        disabled={save.isPending || (!uncertain && (wanted.size === 0 || (mode === 'attach' && !target)))}
        onClick={() => {
          if (submitting.current || !lifecycle.current) return;
          submitting.current = true;
          save.mutate(lifecycle.current);
        }}
      >
        {save.isPending ? '添加中…' : uncertain ? '重试上次添加' : `添加 ${wanted.size} 项`}
      </Button>
    </div>
  );

  return (
    <>
      <Dialog
        open
        title="分类模板库"
        description="添加到我的分类目录"
        className="category-template-dialog"
        onClose={close}
        mobileFullscreen
        footer={footer}
      >
        <div className="category-templates">
          <div className="category-template-modes" aria-label="添加方式">
            <Button
              variant={mode === 'new' ? 'primary' : 'secondary'}
              aria-pressed={mode === 'new'}
              disabled={locked}
              onClick={() => changeMode('new')}
            >
              新建分类
            </Button>
            <Button
              variant={mode === 'attach' ? 'primary' : 'secondary'}
              aria-pressed={mode === 'attach'}
              disabled={locked}
              onClick={() => changeMode('attach')}
            >
              添加到已有分类
            </Button>
          </div>
          {mode === 'new' ? (
            <p className="category-template-hint">点击分类可选择，有子分类时自动展开。</p>
          ) : (
            <button
              type="button"
              className="category-template-target-trigger"
              aria-label={target ? `更换目标分类${target.name}` : '选择已有分类'}
              disabled={locked}
              onClick={openTargetPicker}
            >
              <span className="category-template-target-prefix">添加到</span>
              {target && (
                <span className="transaction-category-symbol category-template-icon">
                  <CategoryIcon name={target.icon} size={20} />
                </span>
              )}
              <span className="category-template-target-name">{target?.name ?? '选择已有分类'}</span>
              <span className="category-template-target-action">{target ? '更换' : '选择'}</span>
              <ChevronRight size={18} />
            </button>
          )}

          <div className="category-template-groups" ref={setGrid}>
            {mode === 'attach' ? (
              <div className="category-template-flat-grid" style={columnStyle} aria-label="可添加分类">
                {items.map((item) => (
                  <section
                    className={`category-template-card${selected.has(item.key) ? ' is-selected' : ''}`}
                    key={item.key}
                  >
                    {choice(item, selected.has(item.key), `选择分类${item.name}`, () => toggle(item.key))}
                  </section>
                ))}
              </div>
            ) : (
              Array.from({ length: Math.ceil(parents.length / columns) }, (_, rowIndex) => {
                const row = parents.slice(rowIndex * columns, rowIndex * columns + columns);
                return (
                  <div className="category-template-row" key={row[0]!.key}>
                    <div className="category-template-card-grid" style={columnStyle}>
                      {row.map((parent) => {
                        const children = items.filter((item) => item.parentKey === parent.key);

                        const chosen = wanted.has(parent.key);
                        return (
                          <section className={`category-template-card${chosen ? ' is-selected' : ''}`} key={parent.key}>
                            {choice(
                              parent,
                              chosen,
                              `选择分类${parent.name}`,
                              () => toggleParent(parent.key),
                              children.length > 0,
                            )}
                          </section>
                        );
                      })}
                    </div>
                    {row
                      .filter((parent) => expandedId === parent.key)
                      .map((parent) => {
                        const children = items.filter((item) => item.parentKey === parent.key);
                        if (!children.length) return null;
                        return (
                          <section
                            className="category-template-children"
                            key={parent.key}
                            aria-label={`${parent.name}的子分类`}
                          >
                            <div className="category-template-child-heading">
                              <span>{parent.name}</span>
                              <span>已选 {children.filter((child) => selected.has(child.key)).length}</span>
                            </div>
                            <div className="category-template-child-grid" style={columnStyle}>
                              {children.map((child) => (
                                <section
                                  className={`category-template-card${selected.has(child.key) ? ' is-selected' : ''}`}
                                  key={child.key}
                                >
                                  {choice(child, selected.has(child.key), `选择${parent.name}中的${child.name}`, () =>
                                    toggle(child.key),
                                  )}
                                </section>
                              ))}
                            </div>
                          </section>
                        );
                      })}
                  </div>
                );
              })
            )}
          </div>
          {save.isError && <ErrorState error={save.error} />}
          {uncertain && <p className="notice">上次添加的结果尚未确认，请重试同一次添加。</p>}
        </div>
        {confirmation}
      </Dialog>
      {targetPickerOpen && (
        <Dialog
          open
          title="选择已有分类"
          showCloseButton={false}
          className="category-template-target-dialog"
          overlayClassName="category-template-target-overlay"
          onClose={() => setTargetPickerOpen(false)}
          footer={
            <Button
              disabled={locked || !targets.some((row) => row.id === pendingTargetId)}
              onClick={() => {
                setTargetParentId(pendingTargetId);
                setTargetPickerOpen(false);
              }}
            >
              确定
            </Button>
          }
        >
          <div className="category-template-target-list" style={columnStyle}>
            {targets.map((row) => (
              <label
                className={`category-template-card category-template-card-choice${pendingTargetId === row.id ? ' is-selected' : ''}`}
                key={row.id}
              >
                <input
                  type="radio"
                  name="template-target"
                  value={row.id}
                  checked={pendingTargetId === row.id}
                  disabled={locked}
                  onChange={() => setPendingTargetId(row.id)}
                  aria-label={`选择已有分类${row.name}`}
                />
                <span className="transaction-category-symbol category-template-icon">
                  <CategoryIcon name={row.icon} size={20} />
                </span>
                <span className="transaction-category-name category-template-name">{row.name}</span>
              </label>
            ))}
          </div>
          {targets.length === 0 && <p className="muted">还没有可用的分类，请先使用“新建分类”。</p>}
        </Dialog>
      )}
    </>
  );
}
