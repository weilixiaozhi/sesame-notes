import { useCallback, useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router';
import { Button, Dialog, ErrorState } from '../../components/ui';

type DraftStatus = { dirty: boolean; pending: boolean };
type DraftSection = 'profile' | 'password' | 'avatar' | 'devices';
export type ReportDraft = (section: DraftSection, status: DraftStatus) => void;
export type ConfirmAction = (action: () => void | Promise<void>, dirty?: boolean, leaving?: boolean) => void;

/** 汇总同一设置页的表单状态，避免多个表单同时注册路由拦截器。 */
export function useSettingsGuard() {
  const [sections, setSections] = useState<Partial<Record<DraftSection, DraftStatus>>>({});
  const [action, setAction] = useState<{ run: () => void | Promise<void>; leaving: boolean } | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  const bypass = useRef(false);
  const dirty = Object.values(sections).some((status) => status.dirty);
  const pending = running || Object.values(sections).some((status) => status.pending);
  const blocker = useBlocker(() => !bypass.current && (dirty || pending));
  const report: ReportDraft = useCallback((section, status) => {
    setSections((previous) =>
      previous[section]?.dirty === status.dirty && previous[section]?.pending === status.pending
        ? previous
        : { ...previous, [section]: status },
    );
  }, []);
  useEffect(() => {
    if (!dirty && !pending) return;
    /** 原生关闭页面仍保护尚未提交的密码、个人资料和头像。 */
    const beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, pending]);
  useEffect(() => {
    if (pending && blocker.state === 'blocked') blocker.reset();
  }, [pending, blocker]);

  /** 明确确认的退出流程可完成一次导航，失败后恢复草稿保护。 */
  async function run(selected: NonNullable<typeof action>) {
    setAction(null);
    setRunning(true);
    setActionError(null);
    bypass.current = selected.leaving;
    try {
      await selected.run();
    } catch (error) {
      setActionError(error);
    } finally {
      bypass.current = false;
      setRunning(false);
    }
  }
  const confirm: ConfirmAction = (next, needsConfirmation = dirty, leaving = false) => {
    if (pending) return;
    const selected = { run: next, leaving };
    if (needsConfirmation) setAction(selected);
    else void run(selected);
  };
  /** 取消放弃操作时不改变任何表单值。 */
  function keepEditing() {
    setAction(null);
    if (blocker.state === 'blocked') blocker.reset();
  }
  return {
    report,
    confirm,
    pending,
    confirmation: (
      <>
        {actionError !== null && <ErrorState error={actionError} />}
        <Dialog
          open={!pending && (action !== null || blocker.state === 'blocked')}
          onClose={keepEditing}
          title="放弃未保存的修改？"
          description="当前输入还没有保存。离开后，需要重新填写。"
        >
          <div className="toolbar">
            <Button variant="secondary" onClick={keepEditing}>
              继续编辑
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pending) return;
                if (blocker.state === 'blocked') {
                  setAction(null);
                  blocker.proceed();
                } else if (action) void run(action);
              }}
            >
              放弃修改
            </Button>
          </div>
        </Dialog>
      </>
    ),
  };
}

/** 子表单只报告状态，页面保持唯一的导航和关闭保护入口。 */
export function useReportDraft(report: ReportDraft, section: DraftSection, dirty: boolean, pending: boolean) {
  useEffect(() => {
    report(section, { dirty, pending });
    return () => report(section, { dirty: false, pending: false });
  }, [report, section, dirty, pending]);
}
