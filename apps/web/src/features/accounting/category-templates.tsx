import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError, unwrap, type components } from '@sesame-notes/api-client';
import { captureSessionOperation, queryClient } from '../../lib/session';
import { useDraftClose } from '../../components/use-draft-close';
import { useProductAnalyticsPage } from '../../lib/use-product-analytics';
import { Button, Dialog, ErrorState, Field } from '../../components/ui';
import catalog from './category-catalog.json';
import { CategoryIcon } from './category-icons';
import { existingTemplate, templateBlockReason, templatePlan } from './category-template-plan';

type Category = components['schemas']['Category'];

/** 整批模板使用固定身份提交；未知回执重试原命令，恢复删除分类须另行明确确认。 */
export function CategoryTemplates({
  ledgerId,
  accountId,
  categories,
  onClose,
  onConflicts,
}: {
  ledgerId: string;
  accountId: string;
  categories: Category[];
  onClose: () => void;
  onConflicts?: () => void;
}) {
  const [mode, setMode] = useState<'flat' | 'hierarchical'>('flat');
  useProductAnalyticsPage(`accounting.categories.templates.${mode}`, true, 3);
  const [selected, setSelected] = useState(new Set<string>());
  const [search, setSearch] = useState('');
  const [reviewed, setReviewed] = useState<{ source: Category[]; rows: Category[] } | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const [notice, setNotice] = useState('');
  const lifecycle = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const attempt = useRef<{ key: string; body: ReturnType<typeof templatePlan>; skipped: number; sent: boolean } | null>(
    null,
  );
  const items = catalog[mode];
  const currentCategories = reviewed?.source === categories ? reviewed.rows : categories;
  const available = useMemo(
    () =>
      items.filter(
        (item) => !existingTemplate(item, currentCategories) && !templateBlockReason(item, items, currentCategories),
      ),
    [items, currentCategories],
  );
  const selectedCount = available.filter((item) => selected.has(item.key)).length;
  useEffect(() => {
    const active = new AbortController();
    lifecycle.current = active;
    attempt.current = null;
    submitting.current = false;
    setSelected(new Set());
    setReviewed(null);
    setUncertain(false);
    setNeedsConfirmation(false);
    return () => active.abort();
  }, [accountId, ledgerId]);
  const save = useMutation({
    mutationFn: async (active: AbortController) => {
      const operation = captureSessionOperation();
      const signal = AbortSignal.any([active.signal, operation.signal]);
      signal.throwIfAborted();
      if (!attempt.current) {
        const fresh = unwrap(
          await operation.client.GET('/api/v1/ledgers/{ledger_id}/categories', {
            signal,
            params: { path: { ledger_id: ledgerId } },
          }),
        );
        operation.assertCurrent();
        signal.throwIfAborted();
        setReviewed({ source: categories, rows: fresh });
        const skipped = items.filter(
          (item) => selected.has(item.key) && templateBlockReason(item, items, fresh),
        ).length;
        attempt.current = {
          key: crypto.randomUUID(),
          body: templatePlan(items, selected, fresh),
          skipped,
          sent: false,
        };
      }
      const command = attempt.current;
      if (command.body.length) {
        command.sent = true;
        unwrap(
          await operation.client.POST('/api/v1/ledgers/{ledger_id}/categories/add-batch', {
            signal,
            params: { path: { ledger_id: ledgerId }, header: { 'idempotency-key': command.key } },
            body: { items: command.body },
          }),
        );
      }
      operation.assertCurrent();
      signal.throwIfAborted();
      return { command, signal };
    },
    onSuccess: completeSave,
    onError: (error, active) => {
      if (
        active.signal.aborted ||
        lifecycle.current !== active ||
        (error instanceof Error && error.name === 'AbortError')
      )
        return;
      const confirmedFailure =
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429;
      if (confirmedFailure) {
        attempt.current = null;
        setUncertain(false);
      } else setUncertain(Boolean(attempt.current?.sent));
      if (error instanceof ApiError && error.status === 409) {
        setNeedsConfirmation(error.code === 'CATEGORY_CONFIRMATION_REQUIRED');
        void queryClient.invalidateQueries({ queryKey: ['account', accountId] });
      }
    },
    onSettled: (_data, _error, active) => {
      if (lifecycle.current === active) submitting.current = false;
    },
  });
  const { close, confirmation, finish } = useDraftClose(selected.size > 0, save.isPending, onClose);
  /** 服务端确认后重新读取权威分类，不用过期的幂等回执覆盖其他设备的新修改。 */
  async function completeSave(result: { command: NonNullable<typeof attempt.current>; signal: AbortSignal }) {
    if (result.signal.aborted) return;
    await queryClient.invalidateQueries({ queryKey: ['account', accountId] });
    if (result.signal.aborted) return;
    attempt.current = null;
    setUncertain(false);
    setNeedsConfirmation(false);
    if (result.command.skipped > 0) {
      setSelected(new Set());
      setNotice(
        `已提交 ${result.command.body.length} 项；${result.command.skipped} 个同名冲突项未添加。请在分类管理中区分名称后再添加。`,
      );
    } else finish();
  }
  const locked = save.isPending || uncertain;
  const visible = items.filter(
    (item) => !search.trim() || item.name.includes(search.trim()) || item.key.includes(search.trim()),
  );
  return (
    <Dialog
      open
      title="添加分类模板"
      description="已添加的模板会跳过；同名自定义分类保留原样。选择子分类会补齐父分类。"
      onClose={close}
    >
      <div className="stack">
        <div className="toolbar">
          <Button
            variant={mode === 'flat' ? 'primary' : 'secondary'}
            disabled={locked}
            onClick={() => {
              setMode('flat');
              setSelected(new Set());
            }}
          >
            一级分类
          </Button>
          <Button
            variant={mode === 'hierarchical' ? 'primary' : 'secondary'}
            disabled={locked}
            onClick={() => {
              setMode('hierarchical');
              setSelected(new Set());
            }}
          >
            分层分类
          </Button>
        </div>
        <Field label="搜索模板">
          <input value={search} onChange={(event) => setSearch(event.target.value)} />
        </Field>
        <div className="toolbar">
          <Button
            variant="ghost"
            disabled={locked}
            onClick={() => setSelected(new Set(available.map((item) => item.key)))}
          >
            全选可添加项
          </Button>
          <Button variant="ghost" disabled={locked} onClick={() => setSelected(new Set())}>
            清空选择
          </Button>
          <span className="muted">已选 {selectedCount} 项</span>
        </div>
        <div className="category-template-grid">
          {visible.map((item) => {
            const exists = !!existingTemplate(item, currentCategories);
            const blocked = templateBlockReason(item, items, currentCategories);
            const parent = item.parent_key ? items.find((parent) => parent.key === item.parent_key)?.name : null;
            return (
              <label className={`category-template-option ${exists || blocked ? 'is-disabled' : ''}`} key={item.key}>
                <input
                  type="checkbox"
                  disabled={exists || Boolean(blocked) || locked}
                  checked={exists || (!blocked && selected.has(item.key))}
                  onChange={(event) => {
                    const next = new Set(selected);
                    if (event.target.checked) next.add(item.key);
                    else next.delete(item.key);
                    setSelected(next);
                  }}
                />
                <CategoryIcon name={item.icon} />
                <span>
                  {parent ? `${parent} / ` : ''}
                  {item.name}
                  {exists && <small>已添加</small>}
                  {blocked && <small>{blocked}</small>}
                </span>
              </label>
            );
          })}
        </div>
        {notice && <p role="status">{notice}</p>}
        {save.isError && <ErrorState error={save.error} />}
        {uncertain && <p className="notice">上次添加的结果尚未确认，请先重试同一操作，再更改选择。</p>}
        {needsConfirmation && (
          <div className="stack">
            <p className="notice">本批分类尚未添加。已有分类的内容或删除状态需要确认，处理后可重新添加模板。</p>
            {onConflicts && (
              <Button variant="secondary" onClick={() => finish(onConflicts)}>
                查看待确认分类
              </Button>
            )}
          </div>
        )}
        <div className="dialog-actions">
          <Button
            disabled={save.isPending || (!uncertain && selectedCount === 0) || needsConfirmation}
            onClick={() => {
              if (submitting.current || !lifecycle.current) return;
              submitting.current = true;
              setNotice('');
              save.mutate(lifecycle.current);
            }}
          >
            {save.isPending ? '添加中…' : uncertain ? '重试上次添加' : '添加所选分类'}
          </Button>
        </div>
      </div>
      {confirmation}
    </Dialog>
  );
}
