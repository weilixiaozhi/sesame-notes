import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type DragEvent,
  type HTMLAttributes,
  type PointerEvent,
} from 'react';
import { ApiError, unwrap } from '@sesame-notes/api-client';
import { api, captureSessionOperation, createChangeBatch, type SyncChange } from '../../lib/session';
import { logMemoError, type MemoBook, type MemoEntry } from './memo-content';
import { credentialReorderPlan, mergeCredentialOrder, moveCredential } from './memo-order';
import './memo-reorder.css';

type ReorderAttempt = {
  batch: ReturnType<typeof createChangeBatch>;
  operation: ReturnType<typeof captureSessionOperation>;
  changes: SyncChange[];
  completed: number;
};
type ReorderDraft = {
  generation: number;
  book: MemoBook;
  entries: readonly MemoEntry[];
  visible: readonly MemoEntry[];
  ids: string[];
  grid: HTMLElement | null;
  attempt?: ReorderAttempt;
};
type CardProps = HTMLAttributes<HTMLElement> & { 'data-entry-id': string };

/** 主列表直接拖动即保存，当前可见排列作为起点，失败保留草稿与幂等批次。 */
export function useCredentialReorder({
  book,
  entries,
  visibleEntries,
  onSaved,
}: {
  book?: MemoBook;
  entries: readonly MemoEntry[];
  visibleEntries: readonly MemoEntry[];
  onSaved: () => void;
}) {
  const [draftRows, setDraftRows] = useState<MemoEntry[] | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [conflicted, setConflicted] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const draft = useRef<ReorderDraft | null>(null);
  const dragging = useRef<string | null>(null);
  const pointerPosition = useRef<{ x: number; y: number } | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const generation = useRef(0);
  const currentBook = useRef(book);
  currentBook.current = book;
  const active = useRef(true);
  const running = useRef(false);
  const lockedRef = useRef(false);
  const excludedDrag = useRef(false);
  const suppressClickUntil = useRef(0);
  const locked = pending || error !== null || draft.current?.attempt !== undefined;
  lockedRef.current = locked;

  useEffect(() => {
    active.current = true;
    const currentGeneration = ++generation.current;
    draft.current = null;
    dragging.current = null;
    running.current = false;
    setDraftRows(null);
    setDragged(null);
    setPending(false);
    setError(null);
    setConflicted(false);
    setProgress({ completed: 0, total: 0 });
    setAnnouncement('');
    return () => {
      active.current = false;
      generation.current = currentGeneration + 1;
      if (scrollFrame.current !== null) window.cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
      pointerPosition.current = null;
    };
  }, [book?.id, book?.sync_id]);

  /** 只向仍展示原本子的页面发布进度，渲染中的本子切换也立即生效。 */
  function canPublish(snapshot: ReorderDraft): boolean {
    return (
      active.current &&
      snapshot.generation === generation.current &&
      currentBook.current?.id === snapshot.book.id &&
      currentBook.current?.sync_id === snapshot.book.sync_id
    );
  }

  /** 每次手势固定完整快照与当前可见顺序，其他排序和搜索结果也能直接调整。 */
  function begin(id: string, grid: HTMLElement | null): boolean {
    if (lockedRef.current || !book || book.type !== 'credentials' || visibleEntries.length < 2) return false;
    try {
      if (!visibleEntries.some((entry) => entry.id === id)) return false;
      draft.current = {
        generation: generation.current,
        book,
        entries: [...entries],
        visible: [...visibleEntries],
        ids: visibleEntries.map((entry) => entry.id),
        grid,
      };
      dragging.current = id;
      setDragged(id);
      return true;
    } catch (caught) {
      logMemoError('开始账号卡片排序失败', caught, { bookId: book.id, entryId: id });
      setError(new Error('暂时无法调整顺序，请重新加载后重试。'));
      return false;
    }
  }

  /** 稳定身份移动立即更新可见草稿，隐藏卡片在最终合并时保持相对顺序。 */
  function move(id: string, index: number) {
    const current = draft.current;
    if (!current || lockedRef.current) return;
    try {
      const next = moveCredential(current.ids, id, index);
      if (next.every((value, position) => value === current.ids[position])) return;
      current.ids = next;
      const byId = new Map(current.visible.map((entry) => [entry.id, entry]));
      setDraftRows(next.map((value) => byId.get(value)!));
      setAnnouncement(`${byId.get(id)?.title || '未命名卡片'}已移到第 ${index + 1} 位`);
    } catch (caught) {
      logMemoError('移动账号卡片失败', caught, { bookId: current.book.id, entryId: id, index });
      setError(new Error('移动没有完成，请重新加载后重试。'));
    }
  }

  /** 指针只命中当前列表和本次手势的可见卡片，避免跨业务卡片参与排序。 */
  function moveAtPointer(x: number, y: number) {
    if (!dragging.current || !draft.current || lockedRef.current) return;
    try {
      const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('.memo-credential-draggable');
      if (!row || !draft.current.grid?.contains(row)) return;
      const index = draft.current.ids.indexOf(row.dataset.entryId ?? '');
      if (index >= 0) move(dragging.current, index);
    } catch (caught) {
      logMemoError('读取账号卡片拖动位置失败', caught, { bookId: draft.current.book.id });
      setError(new Error('拖动没有完成。也可以选中句柄后，用键盘上下键调整。'));
    }
  }

  /** 手指靠近窗口边缘时连续滚动页面，长列表可以在一次手势中跨屏调整。 */
  function autoScrollPointer() {
    scrollFrame.current = null;
    if (!dragging.current || lockedRef.current || !pointerPosition.current) return;
    try {
      const { x, y } = pointerPosition.current;
      const distance = y < 56 ? -12 : y > window.innerHeight - 56 ? 12 : 0;
      if (distance === 0) return;
      const previous = window.scrollY;
      window.scrollBy({ top: distance, behavior: 'auto' });
      if (window.scrollY === previous) return;
      moveAtPointer(x, y);
      scrollFrame.current = window.requestAnimationFrame(autoScrollPointer);
    } catch (caught) {
      logMemoError('滚动账号卡片列表失败', caught, { bookId: draft.current?.book.id ?? '' });
      setError(new Error('页面暂时无法自动滚动。可以用键盘上下键调整顺序。'));
    }
  }

  /** 结束手势释放滚动状态；取消手势只恢复展示，松手保存由调用方主动发起。 */
  function stopGesture(cancel = false) {
    dragging.current = null;
    pointerPosition.current = null;
    if (scrollFrame.current !== null) window.cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
    setDragged(null);
    if (cancel && !running.current && !draft.current?.attempt) {
      draft.current = null;
      setDraftRows(null);
    }
  }

  /** 核对整本身份和修订号后逐项提交，离开页面仍完成已确认批次，冲突拒绝覆盖新内容。 */
  async function save() {
    const snapshot = draft.current;
    if (!snapshot || running.current || conflicted) return;
    if (!snapshot.attempt && snapshot.ids.every((id, index) => id === snapshot.visible[index]?.id)) {
      draft.current = null;
      setDraftRows(null);
      return;
    }
    running.current = true;
    lockedRef.current = true;
    setPending(true);
    setError(null);
    try {
      if (!snapshot.attempt) {
        const operation = captureSessionOperation();
        const batch = createChangeBatch();
        const current = unwrap(
          await api.GET('/api/v1/sync/memo-books/full', {
            signal: operation.signal,
            params: { query: { memo_book_id: snapshot.book.id, sync_id: snapshot.book.sync_id } },
          }),
        );
        operation.assertCurrent();
        const latest = new Map(current.memo_entries.map((entry) => [entry.id, entry]));
        if (
          current.memo_book.id !== snapshot.book.id ||
          current.memo_book.sync_id !== snapshot.book.sync_id ||
          latest.size !== snapshot.entries.length ||
          snapshot.entries.some((entry) => latest.get(entry.id)?.revision !== entry.revision)
        ) {
          throw new ApiError(409, 'MEMO_ORDER_CHANGED', '卡片已在其他设备修改，请重新加载后再调整。');
        }
        const fullIds = mergeCredentialOrder(
          snapshot.entries,
          snapshot.visible.map((entry) => entry.id),
          snapshot.ids,
        );
        const plan = credentialReorderPlan(snapshot.entries, fullIds);
        const updatedAt = new Date().toISOString();
        snapshot.attempt = {
          batch,
          operation,
          completed: 0,
          changes: plan.map(({ entry, orderKey }) => ({
            mutation_id: crypto.randomUUID(),
            entity_type: 'memo_entry',
            entity_id: entry.id,
            ledger_id: null,
            day_book_id: null,
            memo_book_id: snapshot.book.id,
            sync_id: entry.sync_id,
            base_revision: entry.revision,
            updated_at: updatedAt,
            action: 'upsert',
            payload: {
              book_type: 'credentials',
              title: entry.title,
              body_format: entry.body_format,
              body: entry.body,
              order_key: orderKey,
              created_at: entry.created_at,
              updated_at: updatedAt,
            },
          })),
        };
      }
      const current = snapshot.attempt;
      current.operation.assertCurrent();
      if (canPublish(snapshot)) setProgress({ completed: current.completed, total: current.changes.length });
      while (current.completed < current.changes.length) {
        // 批次绑定开始保存时的会话，账号切换由同步层阻止，页面卸载仅停止界面回调。
        await current.batch.push(current.changes[current.completed]!);
        current.completed++;
        if (canPublish(snapshot)) setProgress({ completed: current.completed, total: current.changes.length });
      }
      await current.batch.invalidate();
      current.operation.assertCurrent();
      if (canPublish(snapshot)) {
        onSaved();
        draft.current = null;
        setDraftRows(null);
        setProgress({ completed: 0, total: 0 });
        setAnnouncement('卡片顺序已保存');
      }
    } catch (caught) {
      logMemoError('保存账号卡片顺序失败', caught, {
        bookId: snapshot.book.id,
        completed: snapshot.attempt?.completed ?? 0,
        total: snapshot.attempt?.changes.length ?? 0,
      });
      if (canPublish(snapshot)) {
        setError(caught);
        if (caught instanceof ApiError && caught.status === 409) setConflicted(true);
      }
    } finally {
      if (snapshot.generation === generation.current) {
        running.current = false;
        lockedRef.current = draft.current?.attempt !== undefined;
        if (active.current) setPending(false);
      }
    }
  }

  /** 重新读取已提交的服务端状态并恢复根列表展示，已成功的部分写入由最新快照保留。 */
  async function reload() {
    if (running.current) return;
    const currentGeneration = generation.current;
    running.current = true;
    lockedRef.current = true;
    setPending(true);
    try {
      const operation = captureSessionOperation();
      await operation.invalidate();
      operation.assertCurrent();
      if (!active.current || currentGeneration !== generation.current) return;
      stopGesture();
      draft.current = null;
      setDraftRows(null);
      setError(null);
      setConflicted(false);
      setProgress({ completed: 0, total: 0 });
      setAnnouncement('已读取最新卡片顺序');
    } catch (caught) {
      logMemoError('重新读取账号卡片顺序失败', caught, { bookId: book?.id ?? '' });
      if (active.current && currentGeneration === generation.current) setError(caught);
    } finally {
      if (currentGeneration === generation.current) {
        running.current = false;
        lockedRef.current = draft.current?.attempt !== undefined;
        if (active.current) setPending(false);
      }
    }
  }

  /** 触屏松手自动保存；系统取消手势时恢复展示，不提交尚未确认的位置。 */
  function endPointer(event: PointerEvent<HTMLButtonElement>, cancel: boolean) {
    if (event.pointerType === 'mouse' || !dragging.current) return;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
    } catch (caught) {
      logMemoError('结束账号卡片触屏拖动失败', caught, { bookId: book?.id ?? '' });
    } finally {
      stopGesture(cancel);
      if (!cancel) void save();
    }
  }

  /** 原生鼠标拖动共用开始逻辑，操作按钮不参与，句柄阻止冒泡后只建立一次快照。 */
  function startNative(event: DragEvent<HTMLElement>, entry: MemoEntry) {
    event.stopPropagation();
    try {
      if (excludedDrag.current || !begin(entry.id, event.currentTarget.closest<HTMLElement>('.memo-grid'))) {
        event.preventDefault();
        return;
      }
      suppressClickUntil.current = Date.now() + 1000;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', entry.id);
    } catch (caught) {
      event.preventDefault();
      stopGesture(true);
      logMemoError('开始账号卡片拖动失败', caught, { bookId: book?.id ?? '', entryId: entry.id });
      setError(new Error('拖动没有完成。可以选中句柄后，用键盘上下键调整。'));
    }
  }

  /** 卡片空白、名称和正文可鼠标拖放，放下时按当前可见位置移动并立即保存。 */
  function rowProps(entry: MemoEntry): CardProps {
    return {
      'data-entry-id': entry.id,
      draggable: !locked && !!book && visibleEntries.length > 1,
      onPointerDown: (event) => {
        const target = event.target as HTMLElement;
        const button = target.closest('button');
        excludedDrag.current =
          !!target.closest('.memo-card-footer') ||
          (!!button && !button.classList.contains('card-main') && !button.classList.contains('memo-reorder-grip'));
      },
      onClickCapture: (event) => {
        if (Date.now() >= suppressClickUntil.current) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClickUntil.current = 0;
      },
      onDragStart: (event) => startNative(event, entry),
      onDragEnd: () => {
        suppressClickUntil.current = Date.now() + 250;
        stopGesture(true);
      },
      onDragOver: (event) => {
        if (!lockedRef.current && dragging.current) event.preventDefault();
      },
      onDrop: (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!dragging.current || !draft.current || lockedRef.current) return;
        const index = draft.current.ids.indexOf(entry.id);
        if (index < 0) return;
        move(dragging.current, index);
        stopGesture();
        void save();
      },
    };
  }

  /** 句柄支持鼠标拖放、触屏捕获和键盘上下键，均在移动完成后自动保存。 */
  function handleProps(entry: MemoEntry): ButtonHTMLAttributes<HTMLButtonElement> {
    return {
      type: 'button',
      'aria-label': `拖动 ${entry.title || '未命名卡片'}`,
      'aria-keyshortcuts': 'ArrowUp ArrowDown',
      disabled: locked || !book || visibleEntries.length < 2,
      draggable: !locked && !!book && visibleEntries.length > 1,
      onClick: (event) => event.stopPropagation(),
      onDragStart: (event) => {
        excludedDrag.current = false;
        startNative(event, entry);
      },
      onDragEnd: () => {
        suppressClickUntil.current = Date.now() + 250;
        stopGesture(true);
      },
      onPointerDown: (event) => {
        if (event.pointerType === 'mouse' || lockedRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        try {
          if (!begin(entry.id, event.currentTarget.closest<HTMLElement>('.memo-grid'))) return;
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch (caught) {
          stopGesture(true);
          logMemoError('开始账号卡片触屏拖动失败', caught, { bookId: book?.id ?? '', entryId: entry.id });
          setError(new Error('拖动没有完成。可以选中句柄后，用键盘上下键调整。'));
        }
      },
      onPointerMove: (event) => {
        if (!dragging.current || event.pointerType === 'mouse' || lockedRef.current) return;
        pointerPosition.current = { x: event.clientX, y: event.clientY };
        moveAtPointer(event.clientX, event.clientY);
        if (scrollFrame.current === null) scrollFrame.current = window.requestAnimationFrame(autoScrollPointer);
      },
      onPointerUp: (event) => endPointer(event, false),
      onPointerCancel: (event) => endPointer(event, true),
      onKeyDown: (event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        event.stopPropagation();
        if (!begin(entry.id, event.currentTarget.closest<HTMLElement>('.memo-grid'))) return;
        const index = draft.current!.ids.indexOf(entry.id);
        move(entry.id, index + (event.key === 'ArrowUp' ? -1 : 1));
        stopGesture();
        void save();
      },
    };
  }

  return {
    visibleEntries: draftRows ?? visibleEntries,
    dragged,
    locked,
    pending,
    error,
    conflicted,
    progress,
    announcement,
    handleProps,
    rowProps,
    retry: save,
    discard: reload,
    reload,
  };
}
