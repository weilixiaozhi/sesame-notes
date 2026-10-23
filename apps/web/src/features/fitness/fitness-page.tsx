import { FitnessTransferDialog } from './transfer/fitness-transfer-dialog';
import { DeleteSpaceDialog } from './delete-space-dialog';
import { useRefreshFitnessSchedule } from './plans/refresh-plan-schedule';
import { OfficialPlanImportDialog } from './plans/official-plan-import';
import { FitnessCalendarPanel } from './calendar-panel';
import { StatisticsPanel } from './statistics-panel';
import { WorkoutDetail } from './workout-detail';
import { ExercisesPanel } from './exercises-panel';
import { TemplatesPanel } from './templates-panel';
import { FitnessPlansPanel } from './plans/fitness-plans-panel';
import { useDraftClose } from '../../components/use-draft-close';
import { useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { ApiError, unwrap } from '@sesame-notes/api-client';
import { ArrowDown, ArrowRight, Check, Clock3, Dumbbell, Pencil, Plus } from 'lucide-react';
import { api, pushChange, useSession, type SyncChange } from '../../lib/session';
import { createDefaultBookProvisioner } from '../../app/default-book';
import { useProductAnalyticsPage } from '../../lib/use-product-analytics';
import {
  beginProductAnalyticsFlow,
  captureProductAnalyticsContext,
  trackProductAction,
  type ProductAnalyticsContext,
} from '../../lib/product-analytics-runtime';
import type { ProductAnalyticsPage } from '../../lib/product-analytics';
import { Button, Dialog, EmptyState, ErrorState, Field, LoadingState, PageHeading } from '../../components/ui';
import { BookTabs } from '../../components/book-tabs';
import { BookWorkspaceHeader } from '../../components/book-workspace-header';
import {
  importTemplate,
  workoutLabels,
  type Catalog,
  type FitnessSpace,
  type FitnessTemplate,
  type Library,
  type OfficialTemplate,
  type TemplatePayload,
  type Workout,
  type WorkoutPayload,
} from './fitness-model';
import { WorkoutEditor } from './workout-editor';
import { loadOfficialCatalog } from './official-catalog';
import './fitness.css';

const tabs = [
  { value: 'workouts', label: '训练记录' },
  { value: 'calendar', label: '训练日历' },
  { value: 'statistics', label: '训练统计' },
  { value: 'templates', label: '我的模板' },
  { value: 'plans', label: '训练计划' },
  { value: 'library', label: '官方内容库' },
  { value: 'exercises', label: '动作库' },
] as const;
type FitnessTab = (typeof tabs)[number]['value'];
const fitnessTabPages: Record<FitnessTab, ProductAnalyticsPage> = {
  workouts: 'fitness.workouts',
  calendar: 'fitness.calendar',
  statistics: 'fitness.statistics',
  templates: 'fitness.templates',
  plans: 'fitness.plans',
  library: 'fitness.library',
  exercises: 'fitness.exercises',
};

/** 云空间与地址栏同步，浏览器前进后退始终回到相同业务上下文。 */
export function FitnessPage() {
  const { session } = useSession();
  const [params, setParams] = useSearchParams();
  const [spaceEditor, setSpaceEditor] = useState<'create' | 'rename' | null>(null);
  const [deletingSpace, setDeletingSpace] = useState<FitnessSpace | null>(null);
  const [transferSpace, setTransferSpace] = useState<FitnessSpace | null>(null);
  const [startWorkoutRequest, setStartWorkoutRequest] = useState<{
    spaceId: string;
    context: ProductAnalyticsContext | null;
  } | null>(null);
  const [provisionDefaultSpace] = useState(() => createDefaultBookProvisioner('fitness', session?.user.user_id ?? ''));
  const spaces = useQuery({
    queryKey: ['account', session?.user.user_id, 'fitness', 'spaces'],
    queryFn: async ({ signal }) => unwrap(await api.GET('/api/v1/sync/fitness-spaces', { signal })),
    enabled: Boolean(session),
  });
  const catalog = useQuery({
    queryKey: ['fitness-catalog'],
    queryFn: ({ signal }) => loadOfficialCatalog(signal),
    staleTime: 60_000,
    refetchOnWindowFocus: 'always',
  });
  const requestedSpace = params.get('space');
  const space = requestedSpace
    ? spaces.data?.fitness_spaces.find((entry) => entry.id === requestedSpace)
    : spaces.data?.fitness_spaces[0];
  const tab = tabs.find((entry) => entry.value === params.get('tab'))?.value ?? 'workouts';

  /** 页签切换保留日历日期；新空间清理旧选择，避免跨空间误带详情。 */
  function navigate(spaceId: string, nextTab = tab) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set('space', spaceId);
      next.set('tab', nextTab);
      next.delete('detail');
      next.delete('workout');
      if (spaceId !== space?.id) {
        next.delete('month');
        next.delete('date');
      }
      return next;
    });
  }

  const startFirstWorkout = useMutation({
    mutationFn: async () => {
      try {
        return await provisionDefaultSpace();
      } catch (error) {
        console.error('准备首次训练空间失败', error);
        throw error;
      }
    },
  });

  /** 默认空间只在用户明确开始记录时创建，进行中的操作保持唯一。 */
  function beginFirstWorkout() {
    if (!session || startFirstWorkout.isPending) return;
    const context = beginProductAnalyticsFlow();
    trackProductAction('fitness_workout_create_click', 'fitness', session.user.user_id, context);
    startFirstWorkout.mutate(undefined, {
      onSuccess: (spaceId) => {
        navigate(spaceId, 'workouts');
        // 回执只通知仍挂载的页面；目录提前刷新时，父级保留本次操作的编辑意图。
        setStartWorkoutRequest({ spaceId, context });
      },
    });
  }

  return (
    <div className="fitness-page">
      <PageHeading title="健身" />
      {catalog.isError && <ErrorState error={catalog.error} retry={() => void catalog.refetch()} />}
      {Boolean(spaces.data?.fitness_spaces.length) && (
        <BookWorkspaceHeader
          label="空间管理"
          disabled={startFirstWorkout.isPending}
          selector={
            <BookTabs
              label="健身空间"
              items={spaces.data?.fitness_spaces ?? []}
              value={space?.id}
              onSelect={(id) => {
                trackProductAction('fitness_space_select');
                navigate(id);
              }}
              disabled={
                spaces.isPending || (spaces.isError && spaces.data === undefined) || startFirstWorkout.isPending
              }
            />
          }
          sections={[
            {
              id: 'create',
              title: '新建',
              content: (
                <Button variant="ghost" onClick={() => setSpaceEditor('create')} disabled={startFirstWorkout.isPending}>
                  <Plus size={17} />
                  新建空间
                </Button>
              ),
            },
            ...(space
              ? [
                  {
                    id: 'settings',
                    title: '设置',
                    content: (
                      <Button variant="ghost" onClick={() => setSpaceEditor('rename')}>
                        <Pencil size={15} />
                        重命名
                      </Button>
                    ),
                  },
                  {
                    id: 'data',
                    title: '数据操作',
                    content: (
                      <>
                        <Button variant="ghost" onClick={() => setTransferSpace(space)}>
                          导入与导出
                        </Button>
                        <Button
                          variant="ghost"
                          className="book-management-delete"
                          onClick={() => setDeletingSpace(space)}
                        >
                          删除空间
                        </Button>
                      </>
                    ),
                  },
                ]
              : []),
          ]}
        />
      )}
      {/* 目录刷新失败只显示错误；已有缓存继续支撑空间内容，编辑中的草稿保持挂载。 */}
      {spaces.isError && spaces.data !== undefined && (
        <ErrorState error={spaces.error} retry={() => void spaces.refetch()} />
      )}
      {startFirstWorkout.isError && <ErrorState error={startFirstWorkout.error} retry={beginFirstWorkout} />}
      {spaces.isPending ? (
        <LoadingState label="正在读取健身空间…" />
      ) : spaces.isError && spaces.data === undefined ? (
        <ErrorState error={spaces.error} retry={() => void spaces.refetch()} />
      ) : !space ? (
        <EmptyState
          title={requestedSpace ? '这个空间不可访问' : '还没有健身空间'}
          description={
            requestedSpace ? '空间可能已删除或不属于当前账号。请选择其他空间。' : '从第一场训练开始，记录每一次进步。'
          }
          action={
            !requestedSpace && (
              <Button disabled={startFirstWorkout.isPending} onClick={beginFirstWorkout}>
                <Plus size={17} /> {startFirstWorkout.isPending ? '正在准备训练…' : '开始第一次训练'}
              </Button>
            )
          }
        />
      ) : (
        <>
          <nav className="fitness-tabs" aria-label="健身功能">
            {tabs.map((entry) => (
              <button
                key={entry.value}
                type="button"
                aria-current={tab === entry.value ? 'page' : undefined}
                onClick={() => {
                  trackProductAction('fitness_tab_select');
                  navigate(space.id, entry.value);
                }}
              >
                {entry.label}
              </button>
            ))}
          </nav>
          {/* 删除确认独占空间，先卸载业务查询，避免删除事件触发已移除空间的重读。 */}
          {deletingSpace?.id !== space.id && (
            <SpaceContent
              key={`${session?.user.user_id}:${space.id}`}
              space={space}
              tab={tab}
              catalog={catalog.data}
              userId={session?.user.user_id ?? ''}
              startWorkout={startWorkoutRequest?.spaceId === space.id}
              startContext={startWorkoutRequest?.context}
              onStartedWorkoutClose={() => setStartWorkoutRequest(null)}
            />
          )}
        </>
      )}
      {transferSpace && <FitnessTransferDialog space={transferSpace} onClose={() => setTransferSpace(null)} />}
      {deletingSpace && (
        <DeleteSpaceDialog
          space={deletingSpace}
          userId={session?.user.user_id ?? ''}
          onClose={() => setDeletingSpace(null)}
          onDeleted={() => {
            setDeletingSpace(null);
            setParams({ tab });
          }}
        />
      )}
      {spaceEditor && (
        <SpaceEditor
          key={spaceEditor === 'rename' ? `rename:${space?.id ?? ''}` : 'create'}
          space={spaceEditor === 'rename' ? space : undefined}
          onClose={() => setSpaceEditor(null)}
          onCreated={(id) => {
            navigate(id);
            setSpaceEditor(null);
          }}
        />
      )}
    </div>
  );
}

/** 空间编辑使用版本条件写入，名称重复合法，身份不可复用。 */
function SpaceEditor({
  space,
  onClose,
  onCreated,
}: {
  space?: FitnessSpace;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  useProductAnalyticsPage('fitness.spaces.edit');
  const [name, setName] = useState(space?.name ?? '');
  const [id] = useState(() => space?.id ?? crypto.randomUUID());
  const [createdAt] = useState(() => space?.created_at ?? new Date().toISOString());
  const [error, setError] = useState<unknown>(null);
  const attempt = useRef<{ name: string; change: SyncChange } | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      const normalized = name.trim();
      if (!normalized || [...normalized].length > 100) throw new Error('空间名称需为 1–100 个字符。');
      if (!attempt.current || attempt.current.name !== normalized) {
        const now = new Date().toISOString();
        attempt.current = {
          name: normalized,
          change: {
            mutation_id: crypto.randomUUID(),
            entity_type: 'fitness_space',
            entity_id: id,
            ledger_id: null,
            day_book_id: null,
            memo_book_id: null,
            fitness_space_id: id,
            ...(space ? { sync_id: space.sync_id } : {}),
            base_revision: space?.revision ?? 0,
            action: 'upsert',
            updated_at: now,
            payload: { name: normalized, created_at: createdAt, updated_at: now },
          },
        };
      }
      try {
        await pushChange(attempt.current.change);
      } catch (failure) {
        // 明确的拒绝不是未收到结果；未知网络结果保留完整请求供幂等重放。
        if (failure instanceof ApiError && failure.status < 500) attempt.current = null;
        throw failure;
      }
    },
    onError: setError,
  });
  const { close, confirmation, finish } = useDraftClose(name !== (space?.name ?? ''), mutation.isPending, onClose);
  return (
    <>
      <Dialog open onClose={close} title={space ? '重命名空间' : '新建健身空间'}>
        <form
          className="fitness-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!mutation.isPending) mutation.mutate(undefined, { onSuccess: () => finish(() => onCreated(id)) });
          }}
        >
          <Field label="空间名称">
            <input
              autoFocus
              maxLength={200}
              value={name}
              disabled={mutation.isPending}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：我的健身记录"
            />
          </Field>
          {error !== null && <ErrorState error={error} />}
          <div className="fitness-dialog-actions">
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? '正在保存…' : '保存空间'}
            </Button>
          </div>
        </form>
      </Dialog>
      {confirmation}
    </>
  );
}

/** 每个空间隔离分页、详情和编辑状态；写入始终携带固定空间与快照版本。 */
function SpaceContent({
  space,
  tab,
  catalog,
  userId,
  startWorkout,
  startContext,
  onStartedWorkoutClose,
}: {
  space: FitnessSpace;
  tab: FitnessTab;
  catalog?: Catalog;
  userId: string;
  startWorkout: boolean;
  startContext?: ProductAnalyticsContext | null;
  onStartedWorkoutClose: () => void;
}) {
  const schedule = useRefreshFitnessSchedule(space, userId);
  const [params, setParams] = useSearchParams();
  const [editor, setEditor] = useState<{
    workout?: Workout;
    template?: FitnessTemplate;
    date?: string;
    context?: ProductAnalyticsContext | null;
  } | null>(null);
  const activeEditor: typeof editor = editor ?? (startWorkout ? { context: startContext } : null);
  useProductAnalyticsPage(fitnessTabPages[tab], true, 1);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [official, setOfficial] = useState<OfficialTemplate | null>(null);
  const [officialPlan, setOfficialPlan] = useState<Library['plans'][number] | null>(null);
  useProductAnalyticsPage('fitness.templates.library.detail', Boolean(official));
  const importIds = useRef(new Map<string, { id: string; payload: TemplatePayload; mutationId: string }>());
  const workouts = useInfiniteQuery({
    queryKey: ['account', userId, 'fitness', space.id, 'workouts'],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      unwrap(
        await api.GET('/api/v1/fitness-spaces/{fitness_space_id}/workouts', {
          params: {
            path: { fitness_space_id: space.id },
            query: { limit: 30, ...(pageParam ? { cursor: pageParam } : {}) },
          },
          signal,
        }),
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: tab === 'workouts',
  });
  const templates = useQuery({
    queryKey: ['account', userId, 'fitness', space.id, 'library-template-origins'],
    queryFn: async ({ signal }) => {
      const items: FitnessTemplate[] = [];
      let cursor: string | undefined;
      do {
        const page = unwrap(
          await api.GET('/api/v1/fitness-spaces/{fitness_space_id}/templates', {
            params: { path: { fitness_space_id: space.id }, query: { limit: 200, ...(cursor ? { cursor } : {}) } },
            signal,
          }),
        );
        items.push(...page.items);
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
      return items;
    },
    enabled: tab === 'library',
  });
  const preferences = useQuery({
    queryKey: ['account', userId, 'fitness', space.id, 'preferences'],
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/fitness-spaces/{fitness_space_id}/preferences', {
          params: { path: { fitness_space_id: space.id }, query: { limit: 1 } },
          signal,
        }),
      ),
  });
  const library = useQuery({
    queryKey: ['fitness-library'],
    queryFn: async ({ signal }) => unwrap(await api.GET('/api/v1/fitness/library', { signal, cache: 'no-cache' })),
    enabled: tab === 'library',
    staleTime: 300000,
    refetchOnWindowFocus: 'always',
  });
  const allWorkouts = workouts.data?.pages.flatMap((page) => page.items) ?? [];
  const allTemplates = templates.data ?? [];
  const selectedId = params.get('detail') ?? params.get('workout');
  const isWorkoutDetail = Boolean(selectedId && ['workouts', 'calendar', 'exercises'].includes(tab));
  const workoutDetail = useQuery({
    queryKey: ['account', userId, 'fitness', space.id, 'workout', selectedId],
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/fitness-spaces/{fitness_space_id}/workouts/{workout_id}', {
          params: { path: { fitness_space_id: space.id, workout_id: selectedId! } },
          signal,
        }),
      ),
    enabled: isWorkoutDetail,
  });
  // 已成功读取的详情在刷新失败时继续支撑输入；首次读取失败不能用列表快照冒充详情。
  const selectedWorkout = isWorkoutDetail
    ? (workoutDetail.data ?? (workoutDetail.isError ? undefined : allWorkouts.find((entry) => entry.id === selectedId)))
    : undefined;
  const names = new Map([
    ...(catalog?.exercises.map((entry) => [entry.id, entry.name_zh] as const) ?? []),
    ...(preferences.data?.items[0]?.custom_exercises.map((entry) => [entry.id, entry.name] as const) ?? []),
  ]);

  /** 详情地址加入历史记录，让返回键首先关闭详情。 */
  function openDetail(id: string) {
    trackProductAction('fitness_workout_open_click');
    const next = new URLSearchParams(params);
    next.set('detail', id);
    setParams(next);
  }
  /** 关闭详情保留当前空间与页签。 */
  function closeDetail() {
    const next = new URLSearchParams(params);
    next.delete('detail');
    next.delete('workout');
    setParams(next, { replace: true });
  }

  /** 安排训练入口只登记用户点击；计划补齐、目录刷新和首次记录回执不产生点击事件。 */
  function openWorkoutEditor(value: NonNullable<typeof editor>): void {
    try {
      const context = beginProductAnalyticsFlow();
      if (!value.workout) trackProductAction('fitness_workout_create_click', undefined, userId, context);
      setEditor({ ...value, context });
    } catch (error) {
      console.warn('[健身] 打开训练编辑暂不可用', error);
      setError(error);
    }
  }

  /** 用户编辑使用打开时的版本，冲突不会覆盖其他设备刚保存的数据。 */
  async function saveWorkout(payload: WorkoutPayload, id: string, mutationId: string, existing?: Workout) {
    await pushChange({
      mutation_id: mutationId,
      entity_type: 'fitness_workout',
      entity_id: id,
      ledger_id: null,
      day_book_id: null,
      memo_book_id: null,
      fitness_space_id: space.id,
      sync_id: space.sync_id,
      base_revision: existing?.revision ?? 0,
      action: 'upsert',
      updated_at: payload.updated_at,
      payload,
    });
    setNotice('训练已保存到云空间。');
  }
  const importMutation = useMutation({
    mutationFn: async ({
      template,
      context,
    }: {
      template: OfficialTemplate;
      context: ProductAnalyticsContext | null;
    }) => {
      const sourceKey = `${template.id}:${template.revision}`;
      let draft = importIds.current.get(sourceKey);
      if (!draft) {
        draft = { id: crypto.randomUUID(), payload: importTemplate(template), mutationId: crypto.randomUUID() };
        importIds.current.set(sourceKey, draft);
      }
      await pushChange({
        mutation_id: draft.mutationId,
        entity_type: 'fitness_template',
        entity_id: draft.id,
        ledger_id: null,
        day_book_id: null,
        memo_book_id: null,
        fitness_space_id: space.id,
        sync_id: space.sync_id,
        base_revision: 0,
        action: 'upsert',
        updated_at: draft.payload.updated_at,
        payload: draft.payload,
      });
      trackProductAction('fitness_template_added', 'fitness.templates.library.detail', userId, context);
      setNotice(`“${template.name.zh}”已添加到我的模板，可独立修改。`);
      importIds.current.delete(sourceKey);
      setOfficial(null);
    },
    onError: setError,
  });

  /** 关闭训练编辑时同步完成首次记录意图，后续目录刷新不会再次打开编辑器。 */
  function closeEditor() {
    setEditor(null);
    onStartedWorkoutClose();
  }

  return (
    <div className="fitness-content">
      {schedule.pending && (
        <p className="fitness-muted" role="status">
          正在补齐到期训练计划…
        </p>
      )}
      {schedule.error && <ErrorState error={schedule.error} retry={schedule.retry} />}
      {schedule.hasMore && (
        <div className="fitness-info">
          还有历史计划周期待补齐。
          <Button variant="secondary" disabled={schedule.pending} onClick={schedule.retry}>
            继续补齐
          </Button>
        </div>
      )}
      {preferences.isError && <ErrorState error={preferences.error} retry={() => void preferences.refetch()} />}
      {notice && (
        <div className="fitness-notice" role="status">
          <Check size={16} />
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice('')} aria-label="关闭提示">
            ×
          </button>
        </div>
      )}
      {error !== null && <ErrorState error={error} />}
      {tab === 'statistics' && (
        <StatisticsPanel space={space} userId={userId} catalog={catalog} preferences={preferences.data?.items[0]} />
      )}
      {tab === 'calendar' && (
        <FitnessCalendarPanel
          space={space}
          userId={userId}
          onWorkout={openDetail}
          onCreate={(date) => openWorkoutEditor({ date })}
        />
      )}
      {tab === 'exercises' && <ExercisesPanel space={space} userId={userId} catalog={catalog} onWorkout={openDetail} />}
      {tab === 'workouts' && (
        <>
          <div className="fitness-section-heading">
            <div>
              <h2>训练记录</h2>
            </div>
            <Button
              onClick={() => {
                closeDetail();
                openWorkoutEditor({});
              }}
            >
              <Plus size={17} /> 安排训练
            </Button>
          </div>
          {workouts.isPending ? (
            <LoadingState label="正在读取训练记录…" />
          ) : workouts.isError && allWorkouts.length === 0 ? (
            <ErrorState error={workouts.error} retry={() => void workouts.refetch()} />
          ) : allWorkouts.length === 0 ? (
            <EmptyState
              title="还没有训练记录"
              action={
                <Button onClick={() => openWorkoutEditor({})}>
                  <Plus size={17} /> 安排第一场训练
                </Button>
              }
            />
          ) : (
            <>
              <div className="fitness-workout-list">
                {allWorkouts.map((workout) => (
                  <button
                    type="button"
                    className="fitness-workout-row"
                    key={workout.id}
                    onClick={() => openDetail(workout.id)}
                  >
                    <span className="fitness-row-icon">
                      <Dumbbell size={21} />
                    </span>
                    <span className="fitness-row-main">
                      <strong>{workout.name}</strong>
                      <span>
                        {workout.scheduled_date} · {workout.exercises.length} 个动作 ·{' '}
                        {workout.exercises.reduce(
                          (count, exercise) => count + exercise.sets.filter((set) => set.completed).length,
                          0,
                        )}{' '}
                        组完成
                      </span>
                    </span>
                    <span className={`fitness-status fitness-status-${workout.status}`}>
                      {workoutLabels[workout.status]}
                    </span>
                    <ArrowRight size={17} />
                  </button>
                ))}
              </div>
              {workouts.isError && (
                <ErrorState
                  error={workouts.error}
                  retry={() => void (workouts.isFetchNextPageError ? workouts.fetchNextPage() : workouts.refetch())}
                />
              )}
              {!workouts.isFetchNextPageError && (
                <LoadMore
                  hasMore={workouts.hasNextPage}
                  busy={workouts.isFetchingNextPage}
                  onClick={() => void workouts.fetchNextPage()}
                />
              )}
            </>
          )}
        </>
      )}
      {tab === 'templates' && (
        <TemplatesPanel
          space={space}
          userId={userId}
          catalog={catalog}
          onWorkout={(template) => openWorkoutEditor({ template })}
        />
      )}
      {tab === 'plans' && <FitnessPlansPanel space={space} userId={userId} catalog={catalog} />}
      {tab === 'library' && (
        <>
          {templates.isError && <ErrorState error={templates.error} retry={() => void templates.refetch()} />}
          <div className="fitness-section-heading">
            <h2>官方训练模板</h2>
          </div>
          {library.isPending ? (
            <LoadingState label="正在读取官方内容库…" />
          ) : library.isError ? (
            <ErrorState error={library.error} retry={() => void library.refetch()} />
          ) : (
            <>
              <div className="fitness-card-grid">
                {library.data?.templates.map((template) => (
                  <button
                    className="fitness-template-card"
                    type="button"
                    key={template.id}
                    onClick={() => {
                      setError(null);
                      setOfficial(template);
                    }}
                  >
                    <span className="fitness-tag">
                      {{ beginner: '入门', intermediate: '进阶', advanced: '高级' }[template.difficulty]}
                    </span>
                    <h3>{template.name.zh}</h3>
                    <p>{template.description.zh}</p>
                    <div className="fitness-meta">
                      <Clock3 size={15} />约 {template.duration_minutes} 分钟
                      <span>· {template.exercises.length} 个动作</span>
                    </div>
                    <span className="fitness-card-link">
                      预览模板 <ArrowRight size={16} />
                    </span>
                  </button>
                ))}
              </div>
              <h2 className="fitness-subheading">官方训练计划</h2>
              <div className="fitness-card-grid">
                {library.data?.plans.map((plan) => (
                  <article className="fitness-template-card" key={plan.id}>
                    <span className="fitness-tag">{plan.cycle_days} 天周期</span>
                    <h3>{plan.name.zh}</h3>
                    <p>{plan.description.zh}</p>
                    <details className="fitness-help">
                      <summary>查看 {plan.cycle_days} 天排班</summary>
                      <ol className="fitness-plan-outline">
                        {plan.days.map((day) => (
                          <li key={day.day_index}>
                            第 {day.day_index + 1} 天 ·{' '}
                            {day.template_id
                              ? (library.data?.templates.find((item) => item.id === day.template_id)?.name.zh ?? '训练')
                              : '休息'}
                          </li>
                        ))}
                      </ol>
                    </details>
                    <Button variant="secondary" onClick={() => setOfficialPlan(plan)}>
                      添加到我的计划
                    </Button>
                  </article>
                ))}
              </div>
            </>
          )}
        </>
      )}
      {isWorkoutDetail && workoutDetail.isPending && !selectedWorkout && <LoadingState label="正在读取训练详情…" />}
      {isWorkoutDetail && workoutDetail.isError && (
        <ErrorState error={workoutDetail.error} retry={() => void workoutDetail.refetch()} />
      )}
      {selectedWorkout && (
        <WorkoutDetail
          key={`detail-${selectedWorkout.id}`}
          workout={selectedWorkout}
          accountId={userId}
          space={space}
          preferences={preferences.data?.items[0]}
          names={names}
          onClose={closeDetail}
          onEdit={() => {
            setEditor({ workout: selectedWorkout });
            closeDetail();
          }}
        />
      )}
      {officialPlan && library.data && (
        <OfficialPlanImportDialog
          plan={officialPlan}
          library={library.data}
          space={space}
          onClose={() => setOfficialPlan(null)}
        />
      )}
      {official && (
        <Dialog
          open
          onClose={() => {
            if (!importMutation.isPending) setOfficial(null);
          }}
          title={official.name.zh}
          description={official.description.zh}
        >
          <div className="fitness-form">
            {templates.isPending && <LoadingState label="正在核对已有个人模板…" />}
            {templates.isError && <ErrorState error={templates.error} retry={() => void templates.refetch()} />}
            <ul className="fitness-official-exercises">
              {official.exercises.map((exercise, index) => (
                <li key={`${exercise.exercise_id}:${index}`}>
                  <strong>{names.get(exercise.exercise_id) ?? exercise.exercise_id}</strong>
                  <span>
                    {exercise.sets} 组 × {exercise.reps} 次 ·{' '}
                    {exercise.weight_mode === 'body_weight'
                      ? '自重'
                      : exercise.weight_mode === 'per_side'
                        ? `每侧 ${exercise.weight_kg} kg`
                        : `${exercise.weight_kg} kg`}
                  </span>
                </li>
              ))}
            </ul>
            {error !== null && <ErrorState error={error} />}
            <p className="fitness-muted">添加到“{space.name}”后保留独立副本，官方更新不会覆盖你的训练内容。</p>
            <div className="fitness-dialog-actions">
              <Button
                disabled={
                  importMutation.isPending ||
                  templates.isPending ||
                  templates.isError ||
                  allTemplates.some(
                    (template) =>
                      template.catalog_origin?.item_id === official.id &&
                      template.catalog_origin.revision === official.revision,
                  )
                }
                onClick={() => {
                  const context = captureProductAnalyticsContext();
                  trackProductAction('fitness_template_add_click', 'fitness.templates.library.detail', userId, context);
                  importMutation.mutate({ template: official, context });
                }}
              >
                {importMutation.isPending
                  ? '正在添加…'
                  : allTemplates.some(
                        (template) =>
                          template.catalog_origin?.item_id === official.id &&
                          template.catalog_origin.revision === official.revision,
                      )
                    ? '已添加到此空间'
                    : '添加到我的模板'}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
      {activeEditor && (
        <WorkoutEditor
          key={`editor-${activeEditor.workout?.id ?? activeEditor.template?.id ?? 'new'}`}
          space={space}
          open
          onClose={closeEditor}
          workout={activeEditor.workout}
          initialDate={activeEditor.date}
          template={activeEditor.template}
          analyticsContext={activeEditor.context}
          catalog={catalog}
          preferences={preferences.data?.items[0]}
          onSave={(payload, id, mutationId) => saveWorkout(payload, id, mutationId, activeEditor.workout)}
        />
      )}
    </div>
  );
}

/** 分页追加显式触发，避免大空间在打开页面时下载全部记录。 */
function LoadMore({ hasMore, busy, onClick }: { hasMore: boolean; busy: boolean; onClick: () => void }) {
  return hasMore ? (
    <div className="fitness-load-more">
      <Button variant="secondary" disabled={busy} onClick={onClick}>
        <ArrowDown size={16} /> {busy ? '正在加载…' : '加载更多'}
      </Button>
    </div>
  ) : null;
}
