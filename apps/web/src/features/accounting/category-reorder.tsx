import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import { unwrap, type components } from '@sesame-notes/api-client';
import { api, queryClient } from '../../lib/session';
import { useDraftClose } from '../../components/use-draft-close';
import { Button, Dialog, ErrorState, Field } from '../../components/ui';
import { CategoryIcon } from './category-icons';
import { categoryReorderPlan, CATEGORY_BATCH_LIMIT } from './category-order';
type Category = components['schemas']['Category'];

/** 拖拽与上下移动共用顺序状态，触屏和键盘也能完成同样操作。 */
export function CategoryReorder({
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
  const [initialCategories] = useState(categories);
  const [parent, setParent] = useState('');
  const [order, setOrder] = useState<string[]>([]);
  const [dragged, setDragged] = useState<string | null>(null);
  const rows = initialCategories
    .filter((row) => (row.parent_id ?? '') === parent)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  const ids = order.length ? order : rows.map((row) => row.id);
  const dirty = order.length > 0 && order.some((id, index) => id !== rows[index]?.id);
  const changes = categoryReorderPlan(rows, ids);
  const exceedsLimit = changes.length > CATEGORY_BATCH_LIMIT;
  const save = useMutation({
    mutationFn: async () => {
      if (!changes.length || exceedsLimit) throw new Error('本次排序变化过多，请减少移动范围后分次调整');
      return unwrap(
        await api.POST('/api/v1/ledgers/{ledger_id}/categories/reorder', {
          params: { path: { ledger_id: ledgerId } },
          body: {
            items: changes,
          },
        }),
      );
    },
    onSuccess: completeSave,
  });
  const { close, confirmation, finish } = useDraftClose(dirty, save.isPending, onClose);
  /** 失效所有关联查询后解除草稿保护，关闭排序窗口。 */
  async function completeSave() {
    await queryClient.invalidateQueries({ queryKey: ['account', accountId] });
    finish();
  }
  /** 同一草稿中移动稳定身份，保存期间保持请求目标不变。 */
  function move(id: string, index: number) {
    if (save.isPending || index < 0 || index >= ids.length) return;
    const next = ids.filter((value) => value !== id);
    next.splice(index, 0, id);
    setOrder(next);
  }
  return (
    <Dialog
      open
      title="调整分类顺序"
      description="拖动分类，或使用上下按钮。保存时会检查其他设备是否已修改排序。"
      onClose={close}
    >
      <div className="stack">
        <Field label="排序范围" hint={dirty ? '请先保存或取消当前排序，再切换范围。' : undefined}>
          <select
            value={parent}
            disabled={dirty || save.isPending}
            onChange={(event) => {
              setParent(event.target.value);
              setOrder([]);
            }}
          >
            <option value="">一级分类</option>
            {categories
              .filter((row) => row.level === 1)
              .map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name} 的子分类
                </option>
              ))}
          </select>
        </Field>
        <ul className="category-list">
          {ids.map((id, index) => {
            const row = rows.find((row) => row.id === id);
            return row ? (
              <li
                key={id}
                className="category-sort-row"
                draggable={!save.isPending}
                onDragStart={(event) => {
                  setDragged(id);
                  event.dataTransfer.setData('text/plain', id);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragged) move(dragged, index);
                  setDragged(null);
                }}
              >
                <GripVertical size={16} />
                <CategoryIcon name={row.icon} />
                <strong>{row.name}</strong>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={save.isPending || index === 0}
                  aria-label={`上移${row.name}`}
                  onClick={() => move(id, index - 1)}
                >
                  <ArrowUp size={16} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={save.isPending || index === ids.length - 1}
                  aria-label={`下移${row.name}`}
                  onClick={() => move(id, index + 1)}
                >
                  <ArrowDown size={16} />
                </Button>
              </li>
            ) : null;
          })}
        </ul>
        {exceedsLimit && (
          <p className="notice" role="alert">
            本次移动需要调整 {changes.length} 个分类，超过单次 {CATEGORY_BATCH_LIMIT}{' '}
            个上限。请撤回部分移动，分次调整较小范围；每次保存仍会整批完成。
          </p>
        )}
        {save.isError && <ErrorState error={save.error} />}
        <div className="dialog-actions">
          <Button disabled={!dirty || exceedsLimit || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? '保存中…' : '保存顺序'}
          </Button>
        </div>
      </div>
      {confirmation}
    </Dialog>
  );
}
