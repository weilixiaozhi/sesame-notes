import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { unwrap } from '@sesame-notes/api-client';
import { ArrowDown, ArrowRight, Copy, Dumbbell, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, pushChange, type SyncChange } from '../../lib/session';
import { Button, Dialog, EmptyState, ErrorState, LoadingState } from '../../components/ui';
import { WorkoutEditor } from './workout-editor';
import { useProductAnalyticsPage } from '../../lib/use-product-analytics';
import { ExercisesView } from './exercises-view';
import type { Catalog, FitnessSpace, FitnessTemplate, TemplatePayload, WorkoutPayload } from './fitness-model';

/** 用户模板使用独立副本与同步版本，编排动作和组不会改变已产生的训练。 */
export function TemplatesPanel({
  space,
  userId,
  catalog,
  onWorkout,
}: {
  space: FitnessSpace;
  userId: string;
  catalog?: Catalog;
  onWorkout: (template: FitnessTemplate) => void;
}) {
  const [params, setParams] = useSearchParams();
  const [editor, setEditor] = useState<{ template?: FitnessTemplate } | null>(null);
  const [deleting, setDeleting] = useState<FitnessTemplate | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const copyAttempts = useRef(
    new Map<string, Extract<SyncChange, { entity_type: 'fitness_template'; action: 'upsert' }>>(),
  );
  const query = useInfiniteQuery({
    queryKey: ['account', userId, 'fitness', space.id, 'templates'],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      unwrap(
        await api.GET('/api/v1/fitness-spaces/{fitness_space_id}/templates', {
          params: {
            path: { fitness_space_id: space.id },
            query: { limit: 30, ...(pageParam ? { cursor: pageParam } : {}) },
          },
          signal,
        }),
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
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
  const templates = query.data?.pages.flatMap((page) => page.items) ?? [];
  const selected = templates.find((entry) => entry.id === params.get('detail'));
  useProductAnalyticsPage('fitness.template', Boolean(selected));
  const requestedId = params.get('detail');
  const { fetchNextPage, hasNextPage, isFetchingNextPage, isError } = query;
  useEffect(() => {
    if (requestedId && !selected && hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage();
  }, [requestedId, selected, hasNextPage, isFetchingNextPage, isError, fetchNextPage]);
  const names = new Map([
    ...(catalog?.exercises.map((entry) => [entry.id, entry.name_zh] as const) ?? []),
    ...(preferences.data?.items[0]?.custom_exercises.map((entry) => [entry.id, entry.name] as const) ?? []),
  ]);
  /** 关闭详情保留当前空间和浏览位置。 */
  function closeDetail() {
    const next = new URLSearchParams(params);
    next.delete('detail');
    setParams(next, { replace: true });
  }
  const copying = useMutation({
    mutationFn: async (source: FitnessTemplate) => {
      // 结果未知时仍按原来源身份重试冻结请求；不因后台刷新版本而重复创建副本。
      let change = copyAttempts.current.get(source.id);
      if (!change) {
        const now = new Date().toISOString();
        const name = `${source.name} · 副本`;
        change = {
          mutation_id: crypto.randomUUID(),
          entity_type: 'fitness_template',
          entity_id: crypto.randomUUID(),
          ledger_id: null,
          day_book_id: null,
          memo_book_id: null,
          fitness_space_id: space.id,
          sync_id: space.sync_id,
          base_revision: 0,
          action: 'upsert',
          updated_at: now,
          payload: {
            name: [...name].length <= 100 ? name : source.name,
            exercises: source.exercises.map((exercise) => ({
              ...structuredClone(exercise),
              id: crypto.randomUUID(),
              sets: exercise.sets.map((set) => ({ ...set, id: crypto.randomUUID() })),
            })),
            ...(source.catalog_origin ? { catalog_origin: structuredClone(source.catalog_origin) } : {}),
            created_at: now,
            updated_at: now,
          },
        };
        copyAttempts.current.set(source.id, change);
      }
      await pushChange(change);
      copyAttempts.current.delete(source.id);
      return change.payload.name;
    },
    onSuccess: (name) => {
      closeDetail();
      setNotice(`已复制模板“${name}”。`);
    },
  });
  const deletion = useMutation({
    mutationFn: async (template: FitnessTemplate) =>
      pushChange({
        mutation_id: crypto.randomUUID(),
        entity_type: 'fitness_template',
        entity_id: template.id,
        ledger_id: null,
        day_book_id: null,
        memo_book_id: null,
        fitness_space_id: space.id,
        sync_id: space.sync_id,
        base_revision: template.revision,
        action: 'delete',
        updated_at: new Date().toISOString(),
        payload: {},
      }),
    onSuccess: () => {
      setDeleting(null);
      closeDetail();
    },
    onError: setError,
  });

  /** 编辑器只输出动作草稿，去除训练执行字段后保存为严格模板载荷。 */
  async function save(draft: WorkoutPayload, id: string, mutationId: string) {
    const original = editor?.template;
    const payload: TemplatePayload = {
      name: draft.name,
      exercises: draft.exercises.map((exercise) => ({
        id: exercise.id,
        exercise_id: exercise.exercise_id,
        rest_seconds: exercise.rest_seconds,
        warmup_rest_seconds: exercise.warmup_rest_seconds,
        sets: exercise.sets.map((set) => ({
          id: set.id,
          kind: set.kind,
          weight: set.weight,
          weight_left: set.weight_left,
          weight_right: set.weight_right,
          reps: set.reps,
        })),
      })),
      created_at: original?.created_at ?? draft.created_at,
      updated_at: draft.updated_at,
      ...(original?.catalog_origin ? { catalog_origin: original.catalog_origin } : {}),
    };
    await pushChange({
      mutation_id: mutationId,
      entity_type: 'fitness_template',
      entity_id: id,
      ledger_id: null,
      day_book_id: null,
      memo_book_id: null,
      fitness_space_id: space.id,
      sync_id: space.sync_id,
      base_revision: original?.revision ?? 0,
      action: 'upsert',
      updated_at: payload.updated_at,
      payload,
    });
  }

  return (
    <div className="fitness-content">
      <div className="fitness-section-heading">
        <h2>我的模板</h2>
        <Button onClick={() => setEditor({})}>
          <Plus size={17} /> 新建模板
        </Button>
      </div>
      {error !== null && <ErrorState error={error} />}
      {notice && (
        <p className="fitness-notice" role="status">
          {notice}
        </p>
      )}
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !templates.length ? (
        <EmptyState title="还没有个人模板" action={<Button onClick={() => setEditor({})}>创建模板</Button>} />
      ) : (
        <>
          <div className="fitness-card-grid">
            {templates.map((template) => (
              <button
                className="fitness-template-card fitness-personal-template-card"
                type="button"
                key={template.id}
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.set('detail', template.id);
                  setParams(next);
                }}
              >
                <span className="fitness-row-icon">
                  <Dumbbell size={21} />
                </span>
                <h3>{template.name}</h3>
                <p>
                  {template.exercises.length} 个动作 ·{' '}
                  {template.exercises.reduce((sum, entry) => sum + entry.sets.length, 0)} 组
                </p>
                <span className="fitness-card-link">
                  查看模板 <ArrowRight size={16} />
                </span>
              </button>
            ))}
          </div>
          {query.hasNextPage && (
            <div className="fitness-load-more">
              <Button
                variant="secondary"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                <ArrowDown size={16} />
                加载更多
              </Button>
            </div>
          )}
        </>
      )}
      {requestedId && !selected && query.hasNextPage && <LoadingState label="正在定位模板…" />}
      {requestedId && !selected && !query.isPending && !query.isError && !query.hasNextPage && (
        <EmptyState
          title="模板不可访问"
          description="模板可能已删除，或不属于当前空间。"
          action={
            <Button variant="secondary" onClick={closeDetail}>
              关闭详情
            </Button>
          }
        />
      )}
      {selected && (
        <Dialog
          open
          onClose={() => {
            if (!copying.isPending) closeDetail();
          }}
          title={selected.name}
          description="模板修改不会覆盖已经生成的计划和训练记录。"
        >
          <div className="fitness-form">
            <ExercisesView exercises={selected.exercises} names={names} />
            {copying.isError && <ErrorState error={copying.error} />}
            <div className="fitness-dialog-actions">
              <Button
                variant="danger"
                disabled={copying.isPending}
                onClick={() => {
                  setDeleting(selected);
                  setError(null);
                  closeDetail();
                }}
              >
                <Trash2 size={16} />
                删除
              </Button>
              <Button
                variant="secondary"
                disabled={copying.isPending}
                onClick={() => {
                  setEditor({ template: selected });
                  closeDetail();
                }}
              >
                <Pencil size={16} />
                编辑模板
              </Button>
              <Button variant="secondary" disabled={copying.isPending} onClick={() => copying.mutate(selected)}>
                <Copy size={16} /> {copying.isPending ? '正在复制…' : '复制模板'}
              </Button>
              <Button
                disabled={copying.isPending}
                onClick={() => {
                  closeDetail();
                  onWorkout(selected);
                }}
              >
                <Plus size={16} />
                安排训练
              </Button>
            </div>
          </div>
        </Dialog>
      )}
      {editor && (
        <WorkoutEditor
          key={editor.template?.id ?? 'new-template'}
          space={space}
          open
          templateMode
          template={editor.template}
          catalog={catalog}
          preferences={preferences.data?.items[0]}
          onClose={() => setEditor(null)}
          onSave={save}
        />
      )}
      {deleting && (
        <Dialog
          open
          onClose={() => {
            if (!deletion.isPending) setDeleting(null);
          }}
          title="删除这个模板？"
          description={`“${deleting.name}”将从模板列表移除。已有计划和训练仍保留独立副本。`}
        >
          <div className="fitness-form">
            {error !== null && <ErrorState error={error} />}
            <div className="fitness-dialog-actions">
              <Button variant="danger" disabled={deletion.isPending} onClick={() => deletion.mutate(deleting)}>
                {deletion.isPending ? '正在删除…' : '确认删除模板'}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
