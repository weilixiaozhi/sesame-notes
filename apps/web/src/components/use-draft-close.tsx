import { useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router';
import { Button, Dialog } from './ui';

/** 为编辑弹窗统一提供草稿保护，路由离开与关闭采用同一个确认入口。 */
export function useDraftClose(dirty: boolean, pending: boolean, onClose: () => void) {
  const [closing, setClosing] = useState(false);
  const saved = useRef(false);
  const blocker = useBlocker(() => !saved.current && (dirty || pending));
  useEffect(() => {
    if (!dirty && !pending) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, pending]);
  useEffect(() => {
    // 保存过程中保持当前页面，不能让路由卸载仍在进行的写操作。
    if (pending && blocker.state === 'blocked') blocker.reset();
  }, [blocker, pending]);

  /** 关闭没有修改的表单可立即完成，其余关闭需要用户明确放弃。 */
  function close() {
    if (pending) return;
    if (dirty) setClosing(true);
    else onClose();
  }

  /** 放弃路由跳转时仍保留全部表单输入。 */
  function keepEditing() {
    setClosing(false);
    if (blocker.state === 'blocked') blocker.reset();
  }

  /** 只有明确点击放弃才丢弃草稿，继续此前被阻止的导航。 */
  function discard() {
    if (pending) return;
    saved.current = true;
    setClosing(false);
    onClose();
    if (blocker.state === 'blocked') blocker.proceed();
  }

  /** 成功保存后同步放行后续选本导航，避免仍处于 pending 的渲染误拦截。 */
  function finish(afterClose?: () => void) {
    saved.current = true;
    onClose();
    afterClose?.();
  }

  const confirmation = (
    <Dialog
      open={!pending && (closing || blocker.state === 'blocked')}
      title="放弃未保存的修改？"
      description="当前输入还没有保存。离开后，需要重新填写。"
      onClose={keepEditing}
    >
      <div className="dialog-actions">
        <Button variant="secondary" onClick={keepEditing}>
          继续编辑
        </Button>
        <Button variant="danger" onClick={discard}>
          放弃修改
        </Button>
      </div>
    </Dialog>
  );
  return { close, confirmation, finish };
}
