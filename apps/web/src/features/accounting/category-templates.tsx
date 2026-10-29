import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Plus } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { ApiError, unwrap, type components } from '@sesame-notes/api-client';
import { captureSessionOperation, queryClient } from '../../lib/session';
import { useDraftClose } from '../../components/use-draft-close';
import { useProductAnalyticsPage } from '../../lib/use-product-analytics';
import { Button, Dialog, ErrorState, Field } from '../../components/ui';
import { CategoryIcon } from './category-icons';
import {
  CategoryTemplateTargetUnavailableError,
  selectedTemplateKeys,
  templatePlan,
  unifiedCategoryTemplates,
} from './category-template-plan';
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
  const [expanded, setExpanded] = useState(new Set<string>());
  const [search, setSearch] = useState('');
  const [targetSearch, setTargetSearch] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [verified, setVerified] = useState<{ source: Category[]; rows: Category[] } | null>(null);
  const [grid, setGrid] = useState<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState(3);
  const lifecycle = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const attempt = useRef<{ key: string; body: ReturnType<typeof templatePlan>; sent: boolean } | null>(null);
  useProductAnalyticsPage('accounting.categories.templates.flat', true, 3);
  const wanted = selectedTemplateKeys(items, selected, mode === 'attach');
  const parentCount = mode === 'new' ? parents.filter((item) => wanted.has(item.key)).length : 0;
  const childCount = wanted.size - parentCount;
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
        const next = Math.max(1, Math.min(4, Math.floor((width + gap) / (font * 6 + gap))));
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
  const query = search.trim();
  const visible = parents.filter((parent) => {
    const children = items.filter((item) => item.parentKey === parent.key);
    return !query || parent.name.includes(query) || children.some((child) => child.name.includes(query));
  });

  /** 切换操作清空本次选择，避免把新建父项的意图带入已有父项。 */
  function changeMode(next: 'new' | 'attach') {
    if (locked || mode === next) return;
    setMode(next);
    setSelected(new Set());
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

  /** 选择当前搜索范围内的节点；无子项的分类在追加模式中也能批量选中。 */
  function selectVisible(includeChildren: boolean) {
    if (locked) return;
    setSelected(
      new Set([
        ...selected,
        ...visible.map((parent) => parent.key),
        ...(includeChildren
          ? items
              .filter(
                (item) =>
                  item.parentKey !== null &&
                  visible.some((parent) => parent.key === item.parentKey) &&
                  (!query ||
                    item.name.includes(query) ||
                    parents.find((parent) => parent.key === item.parentKey)?.name.includes(query)),
              )
              .map((item) => item.key)
          : []),
      ]),
    );
  }

  return (
    <Dialog open title="分类模板" description="选择需要的分类，添加后可自由修改。" onClose={close} mobileFullscreen>
      <div className="stack category-templates">
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
        <p className="muted">
          {mode === 'new'
            ? '可以单独选择分类，也可以展开并选择它的子分类。'
            : '先选择已有分类，所选模板都会直接作为它的子分类加入。'}
        </p>
        {mode === 'attach' && (
          <fieldset className="category-template-targets" disabled={locked}>
            <legend>选择目标分类</legend>
            <Field label="查找已有分类">
              <input
                value={targetSearch}
                onChange={(event) => setTargetSearch(event.target.value)}
                placeholder="按名称查找"
              />
            </Field>
            <div className="category-template-target-list">
              {targets
                .filter((row) => row.name.includes(targetSearch.trim()))
                .map((row) => (
                  <label className="category-template-option" key={row.id}>
                    <input
                      type="radio"
                      name="template-target"
                      value={row.id}
                      checked={targetParentId === row.id}
                      onChange={() => setTargetParentId(row.id)}
                    />
                    <CategoryIcon name={row.icon} />
                    <span>
                      {row.name}
                      <small>
                        {currentCategories.filter((child) => child.parent_id === row.id && !child.deleted_at).length}{' '}
                        个子分类
                      </small>
                    </span>
                  </label>
                ))}
            </div>
            {targets.length === 0 && <p className="muted">还没有可用的分类，请先使用“新建分类”。</p>}
          </fieldset>
        )}
        <Field label="搜索模板">
          <input
            disabled={locked}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索分类或子分类"
          />
        </Field>
        <div className="toolbar">
          {mode === 'new' && (
            <Button variant="ghost" disabled={locked} onClick={() => selectVisible(false)}>
              选择当前分类
            </Button>
          )}
          <Button variant="ghost" disabled={locked} onClick={() => selectVisible(true)}>
            {mode === 'attach' ? '选择当前模板' : '选择当前分类及子分类'}
          </Button>
          <Button variant="ghost" disabled={locked || selected.size === 0} onClick={() => setSelected(new Set())}>
            清空选择
          </Button>
        </div>
        <div className="category-template-groups" ref={setGrid}>
          {Array.from({ length: Math.ceil(visible.length / columns) }, (_, rowIndex) => {
            const row = visible.slice(rowIndex * columns, rowIndex * columns + columns);
            return (
              <div className="category-template-row" key={row[0]!.key}>
                <div
                  className="category-template-card-grid"
                  style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
                >
                  {row.map((parent) => {
                    const children = items.filter((item) => item.parentKey === parent.key);
                    const open = expanded.has(parent.key) || Boolean(query);
                    const chosen = mode === 'new' ? wanted.has(parent.key) : selected.has(parent.key);
                    return (
                      <section className={`category-template-card${chosen ? ' is-selected' : ''}`} key={parent.key}>
                        <label className="category-template-card-choice">
                          <input
                            type="checkbox"
                            aria-label={`选择分类${parent.name}`}
                            disabled={locked}
                            checked={chosen}
                            onChange={() => toggleParent(parent.key)}
                          />
                          <CategoryIcon name={parent.icon} size={26} />
                          <span>{parent.name}</span>
                        </label>
                        {children.length > 0 ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-expanded={open}
                            aria-label={`${open ? '收起' : '展开'}${parent.name}子分类`}
                            onClick={() =>
                              setExpanded((previous) => {
                                const next = new Set(previous);
                                if (!next.delete(parent.key)) next.add(parent.key);
                                return next;
                              })
                            }
                          >
                            {children.length} 个子分类{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                          </Button>
                        ) : (
                          <span className="category-template-no-children">无子分类</span>
                        )}
                      </section>
                    );
                  })}
                </div>
                {row
                  .filter((parent) => expanded.has(parent.key) || Boolean(query))
                  .map((parent) => {
                    const children = items.filter(
                      (item) =>
                        item.parentKey === parent.key &&
                        (!query || parent.name.includes(query) || item.name.includes(query)),
                    );
                    if (!children.length) return null;
                    return (
                      <section
                        className="category-template-children"
                        key={parent.key}
                        aria-label={`${parent.name}的子分类`}
                      >
                        <p>{parent.name} · 子分类</p>
                        {mode === 'new' &&
                          !selected.has(parent.key) &&
                          children.some((child) => selected.has(child.key)) && (
                            <p className="category-template-auto">将一起新建所属分类「{parent.name}」</p>
                          )}
                        <div className="category-template-grid">
                          {children.map((child) => (
                            <label className="category-template-option" key={child.key}>
                              <input
                                type="checkbox"
                                aria-label={`选择${parent.name}中的${child.name}`}
                                disabled={locked}
                                checked={selected.has(child.key)}
                                onChange={() => toggle(child.key)}
                              />
                              <CategoryIcon name={child.icon} />
                              <span>{child.name}</span>
                            </label>
                          ))}
                        </div>
                      </section>
                    );
                  })}
              </div>
            );
          })}
          {visible.length === 0 && <p className="muted">没有找到相关模板，试试其他名称。</p>}
        </div>
        <div className="category-template-summary" role="status">
          {mode === 'new'
            ? `本次新建 ${parentCount} 个分类、${childCount} 个子分类`
            : target
              ? `向「${target.name}」添加 ${childCount} 个子分类`
              : '请选择目标分类'}
        </div>
        {save.isError && <ErrorState error={save.error} />}
        {uncertain && <p className="notice">上次添加的结果尚未确认，请重试同一次添加。</p>}
        <div className="dialog-actions">
          <Button
            disabled={save.isPending || (!uncertain && (wanted.size === 0 || (mode === 'attach' && !target)))}
            onClick={() => {
              if (submitting.current || !lifecycle.current) return;
              submitting.current = true;
              save.mutate(lifecycle.current);
            }}
          >
            <Plus size={17} />
            {save.isPending
              ? '添加中…'
              : uncertain
                ? '重试上次添加'
                : mode === 'new'
                  ? `新建 ${wanted.size} 个分类`
                  : `添加 ${childCount} 个子分类`}
          </Button>
        </div>
      </div>
      {confirmation}
    </Dialog>
  );
}
