import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  useRef,
  type ComponentPropsWithRef,
  type ReactNode,
} from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { AlertCircle, Inbox, LoaderCircle, X } from 'lucide-react';
import { cva } from 'class-variance-authority';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { errorMessage } from '../lib/errors';
import { isMobileDialogViewport, useDialogViewport } from '../lib/use-dialog-viewport';

const buttonVariants = cva('button', {
  variants: {
    variant: {
      primary: 'button-primary',
      secondary: 'button-secondary',
      ghost: 'button-ghost',
      danger: 'button-danger',
    },
    size: { sm: 'button-sm', md: '' },
  },
  defaultVariants: { variant: 'primary', size: 'md' },
});

/** 按 shadcn 的可组合模式封装按钮，保留所有原生无障碍属性。 */
export function Button({
  variant,
  size,
  className,
  type = 'button',
  ...props
}: ComponentPropsWithRef<'button'> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
}) {
  return <button type={type} className={twMerge(clsx(buttonVariants({ variant, size }), className))} {...props} />;
}

/** 将输入控件与可见标签关联，错误提示保留在控件附近。 */
export function Field({
  label,
  children,
  error,
  hint,
}: {
  label: string;
  children: ReactNode;
  error?: string;
  hint?: string;
}) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  let associated = false;
  /** 兼容密码框外层装饰元素，只关联第一个原生表单控件。 */
  const associate = (nodes: ReactNode): ReactNode =>
    Children.map(nodes, (node) => {
      if (!isValidElement<Record<string, unknown>>(node) || typeof node.type !== 'string') return node;
      if (!associated && ['input', 'select', 'textarea'].includes(node.type)) {
        associated = true;
        return cloneElement(node, { id, 'aria-describedby': describedBy, 'aria-invalid': Boolean(error) });
      }
      if (node.props.children) return cloneElement(node, {}, associate(node.props.children as ReactNode));
      return node;
    });
  const controls = associate(children);
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {controls}
      {hint && (
        <span id={`${id}-hint`} className="field-hint">
          {hint}
        </span>
      )}
      {error && (
        <span id={`${id}-error`} role="alert" className="field-error">
          {error}
        </span>
      )}
    </div>
  );
}

/** 使用 Radix 处理弹窗焦点、Escape 和关闭后的焦点恢复。 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  heading,
  className,
  overlayClassName,
  mobileFullscreen = false,
  autoFocus = true,
  showCloseButton = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  heading?: ReactNode;
  className?: string;
  overlayClassName?: string;
  mobileFullscreen?: boolean;
  autoFocus?: boolean;
  showCloseButton?: boolean;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const viewportStyle = useDialogViewport(open && mobileFullscreen);
  const returnFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current)
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  wasOpen.current = open;
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={clsx('dialog-overlay', overlayClassName)} />
        <DialogPrimitive.Content
          ref={contentRef}
          className={clsx('dialog', mobileFullscreen && 'dialog-mobile-fullscreen', className)}
          style={viewportStyle}
          {...(!description ? { 'aria-describedby': undefined } : {})}
          onOpenAutoFocus={(event) => {
            try {
              // 手机全屏先聚焦弹层本身，让用户选择分类时无需先收起输入键盘。
              if (!autoFocus || (mobileFullscreen && isMobileDialogViewport())) {
                event.preventDefault();
                contentRef.current?.focus({ preventScroll: true });
              }
            } catch (error) {
              event.preventDefault();
              console.error('设置弹窗初始焦点失败，请点击需要操作的内容', { title, error });
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            try {
              if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
            } catch (error) {
              console.error('恢复弹窗入口焦点失败，请点击需要操作的内容', { title, error });
            }
          }}
        >
          <header className="dialog-heading">
            {heading ? (
              <>
                <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
                {heading}
              </>
            ) : (
              <div>
                <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
                {description && <DialogPrimitive.Description>{description}</DialogPrimitive.Description>}
              </div>
            )}
            {showCloseButton && (
              <button type="button" className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
                <X size={20} />
              </button>
            )}
          </header>
          <div className="dialog-body">{children}</div>
          {footer && <footer className="dialog-footer">{footer}</footer>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** 页面标题保持移动与桌面相同的信息层级。 */
export function PageHeading({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

/** 真实空数据与加载、失败状态分别呈现。 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Inbox size={28} strokeWidth={1.5} />
      </span>
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}

/** 错误面板允许用户重试，避免静默表现为空列表。 */
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div role="alert" className="error-state">
      <AlertCircle size={20} />
      <div>
        <p>{errorMessage(error)}</p>
        {retry && (
          <Button variant="secondary" size="sm" onClick={retry}>
            重新加载
          </Button>
        )}
      </div>
    </div>
  );
}

/** 加载状态通过 live region 向辅助技术报告。 */
export function LoadingState({ label = '正在加载…' }: { label?: string }) {
  return (
    <div role="status" className="loading-state">
      <LoaderCircle className="spin" size={22} />
      <span>{label}</span>
    </div>
  );
}
