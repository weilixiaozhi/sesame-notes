import { useRef, useState } from 'react';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { unwrap, type paths } from '@sesame-notes/api-client';
import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { api, pushChange, queryClient } from '../../../lib/session';
import { useDraftClose } from '../../../components/use-draft-close';
import { useProductAnalyticsPage } from '../../../lib/use-product-analytics';
import {
  captureProductAnalyticsContext,
  trackProductAction,
  type ProductAnalyticsContext,
} from '../../../lib/product-analytics-runtime';
import { Button, Dialog, EmptyState, ErrorState, Field, LoadingState } from '../../../components/ui';
import { localToday, type Catalog, type FitnessPlan, type FitnessSpace, type FitnessTemplate } from '../fitness-model';
import {
  assignPlanDay,
  maxCycleDays,
  movePlanDay,
  newPlanDraft,
  planDateOffset,
  resizePlan,
  submissionPayload,
  type PlanDraft,
} from './plan-model';
import './plans.css';

type Command =
  paths['/api/v1/fitness-spaces/{fitness_space_id}/plans/{plan_id}/command']['post']['requestBody']['content']['application/json'];
type CommandResult =
  paths['/api/v1/fitness-spaces/{fitness_space_id}/plans/{plan_id}/command']['post']['responses'][200]['content']['application/json'];
const pageSize = 14;

/** 通过独立后端事务生成完整周期，响应失败时保留同一个命令用于安全重试。 */
async function executeCommand(
  space: FitnessSpace,
  planId: string,
  body: Command,
  userId: string,
): Promise<CommandResult> {
  try {
    return unwrap(
      await api.POST('/api/v1/fitness-spaces/{fitness_space_id}/plans/{plan_id}/command', {
        params: { path: { fitness_space_id: space.id, plan_id: planId } },
        body,
      }),
    );
  } finally {
    await queryClient.invalidateQueries({ queryKey: ['account', userId, 'fitness', space.id] });
  }
}

/** 用户计划独立分页读取，不因父页面仅加载首屏而漏掉已有计划或模板。 */
export function FitnessPlansPanel({
  space,
  userId,
  catalog,
}: {
  space: FitnessSpace;
  userId: string;
  catalog?: Catalog;
}) {
  const [editor, setEditor] = useState<{ plan?: FitnessPlan; status?: FitnessPlan['status'] } | null>(null);
  const [detail, setDetail] = useState<FitnessPlan | null>(null);
  const [removing, setRemoving] = useState<FitnessPlan | null>(null);
  const [notice, setNotice] = useState('');
  const continuation = useRef(new Map<string, { revision: number; command: Command }>());
  const plans = useInfiniteQuery({
    queryKey: ['account', userId, 'fitness', space.id, 'plans'],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      unwrap(
        await api.GET('/api/v1/fitness-spaces/{fitness_space_id}/plans', {
          params: {
            path: { fitness_space_id: space.id },
            query: { limit: 30, cursor: pageParam, sync_id: space.sync_id },
          },
          signal,
        }),
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const templates = useInfiniteQuery({
    queryKey: ['account', userId, 'fitness', space.id, 'plan-templates'],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      unwrap(
        await api.GET('/api/v1/fitness-spaces/{fitness_space_id}/templates', {
          params: {
            path: { fitness_space_id: space.id },
            query: { limit: 100, cursor: pageParam, sync_id: space.sync_id },
          },
          signal,
        }),
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const generation = useMutation({
    mutationFn: async (plan: FitnessPlan) => {
      let attempt = continuation.current.get(plan.id);
      if (!attempt || attempt.revision !== plan.revision) {
        attempt = {
          revision: plan.revision,
          command: {
            mutation_id: crypto.randomUUID(),
            sync_id: space.sync_id,
            base_revision: plan.revision,
            today: localToday(),
            action: 'generate',
          },
        };
        continuation.current.set(plan.id, attempt);
      }
      const result = await executeCommand(space, plan.id, attempt.command, userId);
      continuation.current.delete(plan.id);
      return result;
    },
    onSuccess: (result) =>
      setNotice(
        result.has_more
          ? `本次补齐 ${result.generated_count} 次训练。仍有较早周期，请继续补齐。`
          : `已补齐到今天，新增 ${result.generated_count} 次训练。`,
      ),
  });
  const allPlans = plans.data?.pages.flatMap((page) => page.items) ?? [];
  const allTemplates = templates.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section className="fitness-content" aria-label="训练计划">
      <div className="fitness-section-heading">
        <h2>训练计划</h2>
        <Button onClick={() => setEditor({})}>
          <Plus size={17} />
          新建计划
        </Button>
      </div>
      <details className="fitness-help">
        <summary>计划规则</summary>
        <p>编辑排班从下一个尚未生成的周期生效；已生成的训练保留原有安排，停用不会删除历史训练。</p>
      </details>
      {notice && (
        <p role="status" className="fitness-notice">
          {notice}
        </p>
      )}
      {generation.isError && <ErrorState error={generation.error} />}
      {plans.isPending ? (
        <LoadingState label="正在加载训练计划…" />
      ) : plans.isError ? (
        <ErrorState error={plans.error} retry={() => void plans.refetch()} />
      ) : allPlans.length === 0 ? (
        <EmptyState
          title="还没有训练计划"
          description="新建计划时可从「我的模板」选择训练内容。"
          action={<Button onClick={() => setEditor({})}>新建计划</Button>}
        />
      ) : (
        <div className="fitness-card-grid fitness-plan-grid">
          {allPlans.map((plan) => (
            <article key={plan.id} className="fitness-template-card">
              <div className="fitness-row plan-card-heading">
                <CalendarDays size={22} />
                <span className={`fitness-status fitness-status-${plan.status}`}>
                  {plan.status === 'in_progress' ? '已启用' : '已停用'}
                </span>
              </div>
              <h3>{plan.name}</h3>
              <p>
                {plan.cycle_days} 天一个周期 · {plan.days.filter((day) => day.slot).length} 个训练日
              </p>
              <p className="fitness-muted">
                开始于 {plan.start_date ?? '尚未指定'}
                <br />
                已生成 {plan.generation_state.generated_cycles.length} 个周期
                {plan.pending_schedule && (
                  <>
                    <br />
                    新的 {plan.pending_schedule.cycle_days} 天排班待下周期生效
                  </>
                )}
              </p>
              <div className="plan-card-actions">
                <div className="plan-card-primary">
                  <Button size="sm" variant="secondary" onClick={() => setDetail(plan)}>
                    查看安排
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditor({ plan })}>
                    <Pencil size={14} />
                    编辑
                  </Button>
                </div>
                <div className="plan-card-secondary">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setEditor({ plan, status: plan.status === 'in_progress' ? 'closed' : 'in_progress' })
                    }
                  >
                    {plan.status === 'in_progress' ? '停用' : '重新启用'}
                  </Button>
                  {plan.status === 'in_progress' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={generation.isPending}
                      onClick={() => generation.mutate(plan)}
                    >
                      <RefreshCw size={14} />
                      补齐到今天
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`删除计划 ${plan.name}`}
                    className="plan-card-delete"
                    onClick={() => setRemoving(plan)}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {plans.hasNextPage && (
        <div className="fitness-load-more">
          <Button variant="secondary" disabled={plans.isFetchingNextPage} onClick={() => void plans.fetchNextPage()}>
            加载更多计划
          </Button>
        </div>
      )}
      {editor && (
        <PlanEditor
          key={editor.plan?.id ?? 'new'}
          space={space}
          userId={userId}
          plan={editor.plan}
          initialStatus={editor.status}
          templates={allTemplates}
          templateLoading={templates.isPending}
          templateError={templates.error}
          hasMoreTemplates={templates.hasNextPage}
          loadingMoreTemplates={templates.isFetchingNextPage}
          onMoreTemplates={() => void templates.fetchNextPage()}
          onRetryTemplates={() => void templates.refetch()}
          onClose={() => setEditor(null)}
          onSaved={(result) => {
            setEditor(null);
            setNotice(
              result.has_more
                ? '计划已保存，尚有历史周期待补齐，可点击「补齐到今天」。'
                : `计划已保存，新增 ${result.generated_count} 次训练。`,
            );
          }}
        />
      )}
      {detail && (
        <PlanDetails
          key={detail.id}
          plan={detail}
          catalog={catalog}
          onClose={() => setDetail(null)}
          onEdit={() => {
            setEditor({ plan: detail });
            setDetail(null);
          }}
        />
      )}
      {removing && <DeletePlan key={removing.id} plan={removing} onClose={() => setRemoving(null)} />}
    </section>
  );
}

/** 完整计划草稿在弹窗内保留，服务器冲突或网络错误不会清空用户排班。 */
function PlanEditor({
  space,
  userId,
  plan,
  initialStatus,
  templates,
  templateLoading,
  templateError,
  hasMoreTemplates,
  loadingMoreTemplates,
  onMoreTemplates,
  onRetryTemplates,
  onClose,
  onSaved,
}: {
  space: FitnessSpace;
  userId: string;
  plan?: FitnessPlan;
  initialStatus?: FitnessPlan['status'];
  templates: FitnessTemplate[];
  templateLoading: boolean;
  templateError: unknown;
  hasMoreTemplates: boolean;
  loadingMoreTemplates: boolean;
  onMoreTemplates: () => void;
  onRetryTemplates: () => void;
  onClose: () => void;
  onSaved: (result: CommandResult) => void;
}) {
  useProductAnalyticsPage('fitness.plans.edit');
  const [original] = useState(plan);
  const [id] = useState(() => plan?.id ?? crypto.randomUUID());
  const [draft, setDraft] = useState<PlanDraft>(() => {
    const next = newPlanDraft(plan);
    if (initialStatus) next.payload.status = initialStatus;
    if (plan?.status === 'closed' && initialStatus === 'in_progress') next.payload.start_date = localToday();
    return next;
  });
  const [cycleInput, setCycleInput] = useState(String(draft.payload.cycle_days));
  const [page, setPage] = useState(0);
  const [dirty, setDirty] = useState(Boolean(initialStatus));
  const [resizeConfirm, setResizeConfirm] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const attempt = useRef<{ signature: string; command: Command } | null>(null);
  const save = useMutation({
    mutationFn: async (context: ProductAnalyticsContext | null) => {
      if (cycleInput !== String(draft.payload.cycle_days)) throw new Error('请先点击「调整周期」应用新的周期天数。');
      const signature = JSON.stringify(draft.payload);
      if (!attempt.current || attempt.current.signature !== signature) {
        const payload = submissionPayload(draft, original);
        attempt.current = {
          signature,
          command: {
            mutation_id: crypto.randomUUID(),
            sync_id: space.sync_id,
            base_revision: original?.revision ?? 0,
            today: localToday(),
            action: 'save',
            plan: payload,
            ...(original?.status === 'closed' && payload.status === 'in_progress'
              ? { restart_date: payload.start_date! }
              : {}),
          },
        };
      }
      const result = await executeCommand(space, id, attempt.current.command, userId);
      trackProductAction('fitness_plan_saved', 'fitness.plans.edit', userId, context);
      return result;
    },
    onError: setError,
  });
  const guard = useDraftClose(dirty, save.isPending, onClose);
  const lockedDate =
    original?.status === 'in_progress' &&
    draft.payload.status === 'in_progress' &&
    original.generation_state.next_cycle_start_date !== null;
  const restarting = original?.status === 'closed' && draft.payload.status === 'in_progress';
  const totalPages = Math.ceil(draft.payload.cycle_days / pageSize);
  const start = page * pageSize;
  /** 所有草稿操作统一标记未保存状态。 */
  function update(next: PlanDraft) {
    setDraft(next);
    setDirty(true);
    setError(null);
  }
  return (
    <>
      <Dialog open title={original ? '编辑训练计划' : '新建训练计划'} onClose={guard.close}>
        <form
          className="fitness-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!save.isPending) {
              const context = captureProductAnalyticsContext();
              trackProductAction('fitness_plan_save_click', 'fitness.plans.edit', userId, context);
              setError(null);
              save.mutate(context, { onSuccess: (result) => guard.finish(() => onSaved(result)) });
            }
          }}
        >
          <Field label="计划名称">
            <input
              autoFocus
              value={draft.payload.name}
              maxLength={200}
              disabled={save.isPending}
              onChange={(event) => update({ ...draft, payload: { ...draft.payload, name: event.target.value } })}
              placeholder="例如：每周力量与恢复"
            />
          </Field>
          <div className="fitness-form-grid">
            <Field label="计划状态">
              <select
                value={draft.payload.status}
                disabled={save.isPending}
                onChange={(event) => {
                  const status = event.target.value === 'closed' ? 'closed' : 'in_progress';
                  update({
                    ...draft,
                    payload: {
                      ...draft.payload,
                      status,
                      ...(original?.status === 'closed' && status === 'in_progress'
                        ? { start_date: localToday() }
                        : {}),
                    },
                  });
                }}
              >
                <option value="in_progress">启用 · 自动安排训练周期</option>
                <option value="closed">停用 · 保留已生成训练</option>
              </select>
            </Field>
            <Field
              label={restarting ? '重新开始日期' : '开始日期'}
              hint={lockedDate ? '已生成周期的开始日期不可修改。' : '新开始日期请选择今天或之后。'}
            >
              <input
                type="date"
                value={draft.payload.start_date ?? ''}
                disabled={save.isPending || Boolean(lockedDate)}
                min={
                  lockedDate || (original && draft.payload.start_date === original.start_date && !restarting)
                    ? undefined
                    : localToday()
                }
                onChange={(event) =>
                  update({ ...draft, payload: { ...draft.payload, start_date: event.target.value } })
                }
              />
            </Field>
          </div>
          {restarting && original.generation_state.generated_cycles.length > 0 && (
            <p role="note" className="fitness-info">
              重新启用将生成一个新周期。这个日期范围内同一计划的原训练会被替换，包括已完成训练；范围之外的历史保留。
            </p>
          )}
          {original?.generation_state.generated_cycles.length && !restarting ? (
            <p className="fitness-info">正在编辑下一个尚未生成的周期。已经生成的训练和休息日不会被重新排列。</p>
          ) : null}
          <div className="plan-cycle-control">
            <Field label="周期天数">
              <input
                type="number"
                min={1}
                max={maxCycleDays}
                step={1}
                inputMode="numeric"
                value={cycleInput}
                disabled={save.isPending}
                onChange={(event) => {
                  setCycleInput(event.target.value);
                  setDirty(true);
                }}
              />
            </Field>
            <Button
              variant="secondary"
              disabled={save.isPending}
              onClick={() => {
                try {
                  if (!/^\d+$/.test(cycleInput)) throw new Error('请输入整数周期天数。');
                  const count = Number(cycleInput);
                  if (count < 1 || count > maxCycleDays) throw new Error('周期请输入 1–36500 天的整数。');
                  if (count < draft.payload.cycle_days) {
                    setResizeConfirm(count);
                    return;
                  }
                  update(resizePlan(draft, count));
                  setCycleInput(String(count));
                  setPage(0);
                } catch (failure) {
                  setError(failure);
                }
              }}
            >
              调整周期
            </Button>
          </div>
          <div className="fitness-row">
            <p className="fitness-muted">
              已明确 {draft.filled.size} / {draft.payload.cycle_days} 天
            </p>
            <Button
              variant="ghost"
              size="sm"
              disabled={save.isPending || draft.filled.size === draft.payload.cycle_days}
              onClick={() => update({ ...draft, filled: new Set(draft.payload.days.map((day) => day.day_index)) })}
            >
              未安排日期设为休息
            </Button>
          </div>
          {templateLoading && <LoadingState label="正在读取我的模板…" />}
          {templateError !== null && <ErrorState error={templateError} retry={onRetryTemplates} />}
          {!templateLoading && !templateError && templates.length === 0 && (
            <p className="fitness-info">还没有可选的训练模板。请先在「我的模板」创建至少一个模板，再回来安排训练日。</p>
          )}
          <div className="plan-days-editor">
            {draft.payload.days.slice(start, start + pageSize).map((day) => {
              const index = day.day_index;
              const savedOnly = day.slot && !templates.some((template) => template.id === day.slot?.source_template_id);
              const value = !draft.filled.has(index)
                ? ''
                : day.slot
                  ? savedOnly
                    ? '__saved'
                    : day.slot.source_template_id!
                  : '__rest';
              return (
                <div key={index} className="plan-day-row">
                  <Field label={`第 ${index + 1} 天`}>
                    <select
                      value={value}
                      disabled={save.isPending}
                      onChange={(event) => {
                        const target = event.target.value;
                        if (target === '__saved' || target === '') return;
                        const template = templates.find((item) => item.id === target);
                        if (target !== '__rest' && !template) return;
                        update(assignPlanDay(draft, index, template ?? null));
                      }}
                    >
                      <option value="" disabled>
                        请选择训练或休息
                      </option>
                      <option value="__rest">休息日</option>
                      {savedOnly && <option value="__saved">{day.slot!.name} · 保留原安排</option>}
                      {templates.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="plan-day-order">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={save.isPending || index === 0}
                      aria-label={`将第 ${index + 1} 天前移`}
                      onClick={() => {
                        update(movePlanDay(draft, index, index - 1));
                        setPage(Math.floor((index - 1) / pageSize));
                      }}
                    >
                      <ArrowUp size={16} />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={save.isPending || index === draft.payload.cycle_days - 1}
                      aria-label={`将第 ${index + 1} 天下移`}
                      onClick={() => {
                        update(movePlanDay(draft, index, index + 1));
                        setPage(Math.floor((index + 1) / pageSize));
                      }}
                    >
                      <ArrowDown size={16} />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
          {totalPages > 1 && (
            <nav className="plan-pagination" aria-label="周期日期分页">
              <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                <ChevronLeft size={16} />
                前14天
              </Button>
              <span>
                {page + 1} / {totalPages}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={page === totalPages - 1}
                onClick={() => setPage(page + 1)}
              >
                后14天
                <ChevronRight size={16} />
              </Button>
            </nav>
          )}
          {hasMoreTemplates && (
            <Button variant="secondary" disabled={loadingMoreTemplates} onClick={onMoreTemplates}>
              加载更多模板
            </Button>
          )}
          {error !== null && <ErrorState error={error} />}
          <div className="fitness-dialog-actions">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? '正在保存并安排训练…' : '保存计划'}
            </Button>
          </div>
        </form>
      </Dialog>
      {guard.confirmation}
      <Dialog
        open={resizeConfirm !== null}
        title="缩短这个周期？"
        description="草稿末尾超出新周期的安排将被移除，已生成训练不受影响。"
        onClose={() => setResizeConfirm(null)}
      >
        <div className="fitness-dialog-actions">
          <Button
            onClick={() => {
              if (resizeConfirm !== null) {
                update(resizePlan(draft, resizeConfirm));
                setCycleInput(String(resizeConfirm));
                setPage(0);
                setResizeConfirm(null);
              }
            }}
          >
            确认缩短
          </Button>
        </div>
      </Dialog>
    </>
  );
}

/** 详情分页呈现完整排班与生成历史，不把历史周期误标为当前草稿。 */
function PlanDetails({
  plan,
  catalog,
  onClose,
  onEdit,
}: {
  plan: FitnessPlan;
  catalog?: Catalog;
  onClose: () => void;
  onEdit: () => void;
}) {
  useProductAnalyticsPage('fitness.plan');
  const [pending, setPending] = useState(false);
  const [page, setPage] = useState(0);
  const [historyCount, setHistoryCount] = useState(10);
  const schedule = pending && plan.pending_schedule ? plan.pending_schedule : plan;
  const startDate = pending ? plan.generation_state.next_cycle_start_date : plan.start_date;
  return (
    <Dialog
      open
      title={plan.name}
      description={`${schedule.cycle_days} 天周期 · ${plan.status === 'in_progress' ? '已启用' : '已停用'}`}
      onClose={onClose}
    >
      <div className="fitness-form">
        {plan.pending_schedule && (
          <Field label="查看排班">
            <select
              value={pending ? 'pending' : 'current'}
              onChange={(event) => {
                setPending(event.target.value === 'pending');
                setPage(0);
              }}
            >
              <option value="current">当前排班</option>
              <option value="pending">下周期待生效排班</option>
            </select>
          </Field>
        )}
        {schedule.days.slice(page * pageSize, (page + 1) * pageSize).map((day) => (
          <section key={day.day_index} className="fitness-plan-day">
            <h3>
              第 {day.day_index + 1} 天 · {day.slot?.name ?? '休息日'}
            </h3>
            {startDate && <p className="fitness-muted">周期起点示例：{planDateOffset(startDate, day.day_index)}</p>}
            {day.slot && (
              <ul className="fitness-plan-outline">
                {day.slot.exercises.map((exercise) => (
                  <li key={exercise.id}>
                    {catalog?.exercises.find((item) => item.id === exercise.exercise_id)?.name_zh ??
                      exercise.exercise_id}{' '}
                    · {exercise.sets.length} 组 · 休息 {exercise.rest_seconds} 秒
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
        {schedule.days.length > pageSize && (
          <nav className="plan-pagination" aria-label="安排详情分页">
            <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>
              上一页
            </Button>
            <span>
              {page + 1} / {Math.ceil(schedule.days.length / pageSize)}
            </span>
            <Button
              size="sm"
              variant="secondary"
              disabled={(page + 1) * pageSize >= schedule.days.length}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </Button>
          </nav>
        )}
        <h3 className="fitness-subheading">已生成周期</h3>
        {!plan.generation_state.generated_cycles.length ? (
          <p className="fitness-muted">尚未生成训练。启用并保存后，会生成第一个周期。</p>
        ) : (
          <ol className="plan-history">
            {plan.generation_state.generated_cycles
              .slice(-historyCount)
              .reverse()
              .map((cycle) => (
                <li key={cycle.cycle_index}>
                  <strong>周期 {cycle.cycle_index + 1}</strong>
                  <span>
                    {cycle.start_date} 至 {planDateOffset(cycle.start_date, cycle.cycle_days - 1)}
                  </span>
                  <span>{cycle.rest_dates.length} 个休息日</span>
                </li>
              ))}
          </ol>
        )}
        {historyCount < plan.generation_state.generated_cycles.length && (
          <Button variant="secondary" onClick={() => setHistoryCount(historyCount + 20)}>
            显示更早周期
          </Button>
        )}
        <div className="fitness-dialog-actions">
          <Button onClick={onEdit}>编辑计划</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** 删除只作用于计划实体，已生成训练与成绩作为独立历史保留。 */
function DeletePlan({ plan, onClose }: { plan: FitnessPlan; onClose: () => void }) {
  const [mutationId] = useState(() => crypto.randomUUID());
  const [updatedAt] = useState(() => new Date().toISOString());
  const remove = useMutation({
    mutationFn: () =>
      pushChange({
        mutation_id: mutationId,
        entity_type: 'fitness_plan',
        entity_id: plan.id,
        ledger_id: null,
        day_book_id: null,
        memo_book_id: null,
        fitness_space_id: plan.fitness_space_id,
        sync_id: plan.sync_id,
        base_revision: plan.revision,
        action: 'delete',
        updated_at: updatedAt,
        payload: {},
      }),
    onSuccess: onClose,
  });
  return (
    <Dialog
      open
      title="删除这个训练计划？"
      description="计划删除后不再生成新训练。已生成的训练、完成成绩与历史记录会保留。"
      onClose={() => {
        if (!remove.isPending) onClose();
      }}
    >
      <div className="fitness-form">
        <p>{plan.name}</p>
        {remove.isError && <ErrorState error={remove.error} />}
        <div className="fitness-dialog-actions">
          <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {remove.isPending ? '正在删除…' : '删除计划'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
