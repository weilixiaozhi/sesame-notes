import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowUpDown, GitCompareArrows, LibraryBig, Pencil, Plus, Trash2 } from 'lucide-react';
import { ApiError, unwrap, type components } from '@sesame-notes/api-client';
import { captureSessionOperation } from '../../lib/session';
import { useDraftClose } from '../../components/use-draft-close';
import { useProductAnalyticsPage } from '../../lib/use-product-analytics';
import { Button, Dialog, EmptyState, ErrorState, Field, LoadingState } from '../../components/ui';
import { createCategorySubmitter } from './entity-submit';
import { CategoryTemplates } from './category-templates';
import { CategoryReorder } from './category-reorder';
import { CategoryRemoval } from './category-removal';
import { CategoryIcon, categoryIcons } from './category-icons';
import { CATEGORY_BATCH_LIMIT } from './category-order';
import { CategoryConflicts } from './category-conflicts';
type Ledger = components['schemas']['Ledger'];
type Category = components['schemas']['Category'];
const nameInput = z.string().trim().min(1, '请输入名称').max(100, '名称最多 100 个字符');
const categoryFormSchema = z.object({ name: nameInput, parentId: z.string(), icon: z.string().max(255) });
type CategoryFormValues = z.infer<typeof categoryFormSchema>;
/** 分类属于账本所有者，编辑成员仅可查看；删除前说明对其他账本的影响。 */
export function CategoryManager({
  ledger,
  accountId,
  categories,
  loading,
  error,
  retry,
  onClose,
}: {
  ledger: Ledger;
  accountId: string;
  categories: Category[];
  loading: boolean;
  error: unknown;
  retry: () => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Category[] | null>(null);
  const [selected, setSelected] = useState(new Set<string>());
  const [templates, setTemplates] = useState(false);
  const [reorder, setReorder] = useState(false);
  const [conflicts, setConflicts] = useState(false);
  const selectedCategories = categories.filter((row) => selected.has(row.id));
  const ordered = [...categories].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  const display = ordered
    .filter((row) => row.parent_id === null)
    .flatMap((parent) => [parent, ...ordered.filter((row) => row.parent_id === parent.id)]);
  return (
    <>
      <Dialog
        open
        title="支出分类"
        description="分类在同一所有者的账本间共用。名称修改和删除会影响这些账本中的分类显示。"
        onClose={onClose}
      >
        <div className="stack">
          {loading ? (
            <LoadingState />
          ) : error ? (
            <ErrorState error={error} retry={retry} />
          ) : categories.length === 0 ? (
            <EmptyState title="还没有分类" description="添加餐饮、出行等分类，让记录更清晰。" />
          ) : (
            <ul className="category-list">
              {display.map((category) => (
                <li key={category.id} className="toolbar">
                  {ledger.role === 'owner' && (
                    <input
                      type="checkbox"
                      aria-label={`选择分类${category.name}`}
                      checked={selected.has(category.id)}
                      disabled={!selected.has(category.id) && selectedCategories.length >= CATEGORY_BATCH_LIMIT}
                      onChange={(event) => {
                        const next = new Set(selected);
                        if (event.target.checked && selectedCategories.length < CATEGORY_BATCH_LIMIT)
                          next.add(category.id);
                        else next.delete(category.id);
                        setSelected(next);
                      }}
                    />
                  )}
                  <CategoryIcon name={category.icon} />
                  <span>
                    {category.parent_id !== null
                      ? `${categories.find((parent) => parent.id === category.parent_id)?.name ?? '其他'} / `
                      : ''}
                    {category.name}
                  </span>
                  {ledger.role === 'owner' && (
                    <div className="toolbar">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`编辑分类${category.name}`}
                        onClick={() => setEditing(category)}
                      >
                        <Pencil size={16} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`删除分类${category.name}`}
                        onClick={() => setDeleting([category])}
                      >
                        <Trash2 size={16} />
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {ledger.role === 'owner' && (
            <p className="muted">
              批量处理一次最多选择 {CATEGORY_BATCH_LIMIT} 个分类，已选 {selectedCategories.length}{' '}
              个；达到上限后可取消已选分类再更换。
            </p>
          )}
          {ledger.role === 'owner' ? (
            <div className="toolbar">
              <Button
                variant="ghost"
                disabled={loading || Boolean(error) || display.length === 0}
                onClick={() => setSelected(new Set(display.slice(0, CATEGORY_BATCH_LIMIT).map((row) => row.id)))}
              >
                {display.length > CATEGORY_BATCH_LIMIT ? `选择前 ${CATEGORY_BATCH_LIMIT} 个分类` : '全选分类'}
              </Button>
              {selectedCategories.length > 0 && (
                <Button variant="ghost" onClick={() => setSelected(new Set())}>
                  取消全选
                </Button>
              )}
              <Button disabled={loading || Boolean(error)} onClick={() => setEditing('new')}>
                <Plus size={17} />
                添加分类
              </Button>
              <Button variant="secondary" disabled={loading || Boolean(error)} onClick={() => setTemplates(true)}>
                <LibraryBig size={17} />
                分类模板
              </Button>
              <Button variant="secondary" onClick={() => setConflicts(true)}>
                <GitCompareArrows size={17} />
                待确认分类
              </Button>
              <Button
                variant="secondary"
                disabled={loading || Boolean(error) || categories.length < 2}
                onClick={() => setReorder(true)}
              >
                <ArrowUpDown size={17} />
                调整顺序
              </Button>
              {selectedCategories.length > 0 && (
                <Button variant="danger" onClick={() => setDeleting(selectedCategories)}>
                  处理所选 {selectedCategories.length} 个分类
                </Button>
              )}
            </div>
          ) : (
            <p className="muted">共享账本的分类由账本所有者维护。</p>
          )}
        </div>
      </Dialog>
      {editing && (
        <CategoryEditor
          ledger={ledger}
          categories={categories}
          existing={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onConflicts={() => setConflicts(true)}
        />
      )}
      {templates && (
        <CategoryTemplates
          ledgerId={ledger.id}
          accountId={accountId}
          categories={categories}
          onClose={() => setTemplates(false)}
        />
      )}
      {reorder && (
        <CategoryReorder
          ledgerId={ledger.id}
          accountId={accountId}
          categories={categories}
          onClose={() => setReorder(false)}
        />
      )}
      {deleting && (
        <CategoryRemoval
          ledgerId={ledger.id}
          accountId={accountId}
          categories={categories}
          sources={deleting}
          onClose={() => {
            setDeleting(null);
            setSelected(new Set());
          }}
        />
      )}
      {conflicts && (
        <CategoryConflicts accountId={accountId} categories={categories} onClose={() => setConflicts(false)} />
      )}
    </>
  );
}

/** 根据父分类确定层级，包含子分类时限制改变层级，保留既有图标与排序。 */
function CategoryEditor({
  ledger,
  categories,
  existing,
  onClose,
  onConflicts,
}: {
  ledger: Ledger;
  categories: Category[];
  existing?: Category;
  onClose: () => void;
  onConflicts: () => void;
}) {
  useProductAnalyticsPage('accounting.categories.edit', true, 3);
  const [submitNew] = useState(() => createCategorySubmitter(ledger.id));
  const form = useForm<CategoryFormValues>({
    resolver: zodResolver(categoryFormSchema),
    defaultValues: { name: existing?.name ?? '', parentId: existing?.parent_id ?? '', icon: existing?.icon ?? '' },
  });
  const hasChildren = categories.some((category) => category.parent_id === existing?.id);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const save = useMutation({
    networkMode: 'always',
    mutationFn: async (values: CategoryFormValues) => {
      const operation = captureSessionOperation();
      const body = {
        name: values.name,
        kind: 'expense' as const,
        parent_id: values.parentId || null,
        level: values.parentId ? (2 as const) : (1 as const),
        icon: values.icon || null,
      };
      if (existing) {
        if (!existing.version_token) throw new Error('缺少云端分类版本，请重新读取分类后打开编辑');
        const signature = JSON.stringify([existing.id, existing.version_token, body]);
        if (!attempt.current || attempt.current.signature !== signature)
          attempt.current = { signature, key: crypto.randomUUID() };
        unwrap(
          await operation.client.PATCH('/api/v1/ledgers/{ledger_id}/categories/{category_id}', {
            params: {
              path: { ledger_id: ledger.id, category_id: existing.id },
              query: { expected_version_token: existing.version_token },
              header: { 'idempotency-key': attempt.current.key },
            },
            body,
          }),
        );
      } else {
        await submitNew({
          ...body,
          sort_order: Math.min(2_147_483_647, Math.max(0, ...categories.map((category) => category.sort_order)) + 1),
        });
      }
      operation.assertCurrent();
      await operation.invalidate();
      operation.assertCurrent();
    },
    onSuccess: completeSave,
  });
  const { close, confirmation, finish } = useDraftClose(form.formState.isDirty, save.isPending, onClose);
  /** 完成权威数据刷新后放行成功退出，避免草稿保护拦截程序内导航。 */
  function completeSave() {
    finish();
  }

  return (
    <Dialog open title={existing ? '编辑分类' : '添加分类'} onClose={close}>
      <form className="stack" onSubmit={form.handleSubmit((values) => save.mutateAsync(values).catch(() => undefined))}>
        <fieldset disabled={save.isPending} className="stack" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <Field label="分类名称" error={form.formState.errors.name?.message}>
            <input autoFocus maxLength={100} placeholder="例如：餐饮" {...form.register('name')} />
          </Field>
          <Field
            label="所属分类"
            hint={hasChildren ? '这个分类包含子分类，不能再放入其他分类。' : '选择所属分类后，将作为它的子分类。'}
          >
            <select {...form.register('parentId')}>
              <option value="">无所属分类</option>
              {categories
                .filter((category) => !hasChildren && category.parent_id === null && category.id !== existing?.id)
                .map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="分类图标">
            <select {...form.register('icon')}>
              <option value="">通用分类图标</option>
              {existing?.icon && !Object.hasOwn(categoryIcons, existing.icon) && (
                <option value={existing.icon}>保留当前图标</option>
              )}
              {Object.keys(categoryIcons).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <div className="category-icon-grid" role="group" aria-label="常用分类图标">
            {Object.keys(categoryIcons).map((name) => (
              <button
                type="button"
                className={`icon-button ${form.watch('icon') === name ? 'is-selected' : ''}`}
                key={name}
                aria-label={`选择图标 ${name}`}
                aria-pressed={form.watch('icon') === name}
                onClick={() => form.setValue('icon', name, { shouldDirty: true })}
              >
                <CategoryIcon name={name} size={21} />
              </button>
            ))}
          </div>
          {save.isError && <ErrorState error={save.error} />}
          {save.error instanceof ApiError && save.error.code === 'CATEGORY_CONFIRMATION_REQUIRED' && (
            <>
              <p className="notice">修改已保存为待确认内容。请核对云端与本地内容后选择保留的一方。</p>
              <Button variant="secondary" onClick={() => finish(onConflicts)}>
                处理待确认分类
              </Button>
            </>
          )}
          <div className="toolbar">
            <Button type="submit" disabled={save.isPending || form.formState.isSubmitting}>
              {save.isPending ? '保存中…' : '保存分类'}
            </Button>
          </div>
        </fieldset>
      </form>
      {confirmation}
    </Dialog>
  );
}
