import * as Dialog from '@radix-ui/react-dialog';
import { X, LoaderCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { errorMessage } from '../api/client';
import { reason, validationError } from '../lib/validation';
import type { Paging } from '../api/types';
import { pageBounds } from '../api/paging';

/** 所有按钮默认仅触发 React 事件，避免未处理的原生表单导航。 */
export function Button({
  variant = 'default',
  className = '',
  ...props
}: ComponentProps<'button'> & { variant?: 'default' | 'primary' | 'danger' | 'ghost' }) {
  return <button {...props} type={props.type ?? 'button'} className={`button button-${variant} ${className}`} />;
}

/** 显示明确状态，颜色仅作为辅助信息。 */
export function StatusBadge({
  enabled,
  enabledLabel = '已启用',
  disabledLabel = '已禁用',
}: {
  enabled: boolean;
  enabledLabel?: string;
  disabledLabel?: string;
}) {
  return (
    <span className={`badge ${enabled ? 'badge-success' : 'badge-danger'}`}>
      {enabled ? enabledLabel : disabledLabel}
    </span>
  );
}

/** 请求失败时显示可操作提示，技术日志由请求边界统一处理。 */
export function RequestError({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="request-error" role="alert">
      <p>{errorMessage(error)}</p>
      {retry && <Button onClick={retry}>重新加载</Button>}
    </div>
  );
}

/** 加载与空状态不会用伪造数据填充。 */
export function Loading({ label = '正在加载…' }: { label?: string }) {
  return (
    <div className="empty" role="status">
      <LoaderCircle className="spin" size={18} />
      {label}
    </div>
  );
}
/** 没有记录时展示业务空态。 */
export function Empty({ children = '暂无记录' }: { children?: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** 弹窗禁止点遮罩隐式关闭，提交期间阻止退出并保留 Radix 的焦点管理。 */
export function Modal({
  title,
  titleAside,
  children,
  onClose,
  busy = false,
  className = '',
  focusCancel = false,
}: {
  title: string;
  titleAside?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  className?: string;
  focusCancel?: boolean;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className={`dialog ${className}`}
          aria-describedby={undefined}
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            if (focusCancel) {
              event.preventDefault();
              closeRef.current?.focus();
            }
          }}
        >
          <div className="dialog-heading">
            <div className="detail-title">
              <Dialog.Title>{title}</Dialog.Title>
              {titleAside}
            </div>
            <Button ref={closeRef} variant="ghost" aria-label="关闭弹窗" disabled={busy} onClick={onClose}>
              <X size={18} />
            </Button>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** 危险操作统一要求原因和一次明确确认；失败保留输入且不乐观修改数据。 */
export function ConfirmDialog({
  title,
  children,
  confirmText = '确认',
  onConfirm,
  onClose,
  danger = true,
  confirmDisabled = false,
}: {
  title: string;
  children: ReactNode;
  confirmText?: string;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
  danger?: boolean;
  confirmDisabled?: boolean;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submitLock = useRef(false);
  /** 保存前验证原因，网络结果不明时保留错误供用户核对。 */
  async function submit() {
    if (submitLock.current || confirmDisabled) return;
    const invalid = validationError(reason, value);
    if (invalid) {
      setError(invalid);
      return;
    }
    submitLock.current = true;
    setBusy(true);
    setError('');
    try {
      await onConfirm(value.trim());
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      submitLock.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal title={title} onClose={onClose} busy={busy} focusCancel>
      <div className="form-stack">
        {children}
        <label className="field">
          操作原因
          <textarea value={value} maxLength={500} onChange={(event) => setValue(event.target.value)} />
        </label>
        {error && (
          <div role="alert" className="form-error">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={busy || confirmDisabled}
            onClick={() => void submit()}
          >
            {busy ? '提交中…' : confirmText}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** 分页只使用服务端返回的同条件总数，支持数字页码、每页数量和越界钳制。 */
export function Pagination({
  value,
  total,
  onChange,
  disabled = false,
}: {
  value: Paging;
  total: number;
  onChange: (next: Paging) => void;
  disabled?: boolean;
}) {
  const { count, page: current } = pageBounds(total, value);
  const [jump, setJump] = useState('');
  const pages = [
    ...new Set([1, current - 1, current, current + 1, count].filter((page) => page >= 1 && page <= count)),
  ].sort((a, b) => a - b);
  return (
    <nav className="pagination" aria-label="分页">
      <span>共 {total} 条</span>
      <label>
        每页
        <select
          aria-label="每页条数"
          disabled={disabled}
          value={value.page_size}
          onChange={(event) => onChange({ page: 1, page_size: Number(event.target.value) as Paging['page_size'] })}
        >
          {[10, 20, 50, 100].map((size) => (
            <option key={size}>{size}</option>
          ))}
        </select>
        条
      </label>
      <div className="pagination-pages">
        <Button disabled={disabled || current === 1} onClick={() => onChange({ ...value, page: current - 1 })}>
          上一页
        </Button>
        {pages.map((page, index) => (
          <span key={page} className="page-number">
            {index > 0 && page - pages[index - 1]! > 1 && <span>…</span>}
            <Button
              aria-current={page === current ? 'page' : undefined}
              disabled={disabled}
              onClick={() => onChange({ ...value, page })}
            >
              {page}
            </Button>
          </span>
        ))}
        <Button disabled={disabled || current >= count} onClick={() => onChange({ ...value, page: current + 1 })}>
          下一页
        </Button>
      </div>
      <form
        className="page-jump"
        onSubmit={(event) => {
          event.preventDefault();
          // 弹窗通过 Portal 渲染时仍沿 React 组件树冒泡，分页不能触发外层编辑器保存。
          event.stopPropagation();
          if (disabled) return;
          const page = Number(jump);
          if (Number.isFinite(page)) onChange({ ...value, page: Math.max(1, Math.min(count, Math.floor(page))) });
          setJump('');
        }}
      >
        <label>
          跳至
          <input
            type="number"
            min="1"
            aria-label="跳转页码"
            value={jump}
            placeholder={String(current)}
            onChange={(event) => setJump(event.target.value)}
          />
        </label>
        <Button type="submit" disabled={disabled || !jump}>
          确定
        </Button>
      </form>
    </nav>
  );
}
