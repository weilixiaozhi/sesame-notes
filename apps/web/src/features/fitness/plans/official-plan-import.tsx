import { useRef, useState } from 'react';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { unwrap, type paths } from '@sesame-notes/api-client';
import { api, queryClient, useSession } from '../../../lib/session';
import { useProductAnalyticsPage } from '../../../lib/use-product-analytics';
import {
  captureProductAnalyticsContext,
  trackProductAction,
  type ProductAnalyticsContext,
} from '../../../lib/product-analytics-runtime';
import { Button, Dialog, ErrorState, Field, LoadingState } from '../../../components/ui';
import {
  importTemplate,
  localToday,
  type FitnessSpace,
  type FitnessTemplate,
  type Library,
  type TemplatePayload,
} from '../fitness-model';

type OfficialPlan = Library['plans'][number];
type ImportCommand =
  paths['/api/v1/fitness-spaces/{fitness_space_id}/plans/{plan_id}/command']['post']['requestBody']['content']['application/json'];

/** 官方内容成为用户副本，槽位、动作、组重新分配身份；已有用户模板始终保持原样。 */
export function buildOfficialPlanImport(
  plan: OfficialPlan,
  library: Library,
  space: FitnessSpace,
  choices: ReadonlyMap<string, FitnessTemplate>,
  now = new Date().toISOString(),
  today = localToday(),
): ImportCommand {
  const mapped = new Map<string, { id: string; payload: TemplatePayload }>();
  const copies: NonNullable<ImportCommand['template_copies']> = [];
  for (const day of plan.days) {
    if (!day.template_id || mapped.has(day.template_id)) continue;
    const existing = choices.get(day.template_id);
    if (existing) {
      if (existing.fitness_space_id !== space.id || existing.catalog_origin?.item_id !== day.template_id)
        throw new Error('选择的模板副本不属于当前空间或官方来源。');
      mapped.set(day.template_id, {
        id: existing.id,
        payload: {
          name: existing.name,
          exercises: structuredClone(existing.exercises),
          ...(existing.catalog_origin ? { catalog_origin: existing.catalog_origin } : {}),
          created_at: existing.created_at,
          updated_at: existing.updated_at,
        },
      });
      continue;
    }
    const source = library.templates.find((template) => template.id === day.template_id);
    if (!source) throw new Error('官方计划引用的模板暂不可用，请刷新内容库。');
    const copy = { id: crypto.randomUUID(), payload: importTemplate(source, now) };
    copies.push(copy);
    mapped.set(day.template_id, copy);
  }
  return {
    mutation_id: crypto.randomUUID(),
    sync_id: space.sync_id,
    base_revision: 0,
    today,
    action: 'save',
    template_copies: copies,
    plan: {
      name: plan.name.zh,
      catalog_origin: { source: 'official', item_id: plan.id, revision: plan.revision },
      status: 'closed',
      start_date: today,
      cycle_days: plan.cycle_days,
      days: plan.days.map((day) => {
        const source = day.template_id ? mapped.get(day.template_id) : undefined;
        return {
          day_index: day.day_index,
          slot: source
            ? {
                id: crypto.randomUUID(),
                source_template_id: source.id,
                name: source.payload.name,
                exercises: source.payload.exercises.map((exercise) => ({
                  ...structuredClone(exercise),
                  id: crypto.randomUUID(),
                  sets: exercise.sets.map((set) => ({ ...set, id: crypto.randomUUID() })),
                })),
              }
            : null,
        };
      }),
      generation_state: { next_cycle_start_date: null, next_cycle_index: 0, generated_cycles: [] },
      pending_schedule: null,
      created_at: now,
      updated_at: now,
    },
  };
}

/** 导入前逐个选择复用或新建模板，计划和新模板副本一次提交、失败可原样重试。 */
export function OfficialPlanImportDialog({
  plan,
  library,
  space,
  onClose,
}: {
  plan: OfficialPlan;
  library: Library;
  space: FitnessSpace;
  onClose: () => void;
}) {
  const { session } = useSession();
  const accountId = session?.user.user_id ?? '';
  useProductAnalyticsPage('fitness.plans.library.detail');
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [complete, setComplete] = useState(false);
  const [planId] = useState(() => crypto.randomUUID());
  const attempt = useRef<{ signature: string; body: ImportCommand } | null>(null);
  const templates = useInfiniteQuery({
    queryKey: ['account', session!.user.user_id, 'fitness', space.id, 'plan-import-templates'],
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
  const all = templates.data?.pages.flatMap((page) => page.items) ?? [];
  const referenced = [...new Set(plan.days.flatMap((day) => (day.template_id ? [day.template_id] : [])))];
  const mutation = useMutation({
    mutationFn: async (context: ProductAnalyticsContext | null) => {
      const signature = JSON.stringify(choices);
      if (!attempt.current || attempt.current.signature !== signature) {
        const selected = new Map<string, FitnessTemplate>();
        for (const [sourceId, id] of Object.entries(choices)) {
          if (!id) continue;
          const template = all.find((item) => item.id === id);
          if (!template) throw new Error('选定的模板副本已不在列表中，请重新选择。');
          selected.set(sourceId, template);
        }
        attempt.current = { signature, body: buildOfficialPlanImport(plan, library, space, selected) };
      }
      const result = unwrap(
        await api.POST('/api/v1/fitness-spaces/{fitness_space_id}/plans/{plan_id}/command', {
          params: { path: { fitness_space_id: space.id, plan_id: planId } },
          body: attempt.current.body,
        }),
      );
      trackProductAction('fitness_plan_added', 'fitness.plans.library.detail', accountId, context);
      return result;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['account', session!.user.user_id, 'fitness', space.id] });
      setComplete(true);
    },
  });
  return (
    <Dialog
      open
      title={complete ? '已添加到我的计划' : '添加官方训练计划'}
      description={plan.name.zh}
      onClose={() => {
        if (!mutation.isPending) onClose();
      }}
    >
      <div className="fitness-form">
        {complete ? (
          <>
            <p>计划和模板副本已保存到「{space.name}」。计划当前停用，请在「训练计划」选择开始日期后启用。</p>
            <div className="fitness-dialog-actions">
              <Button onClick={onClose}>完成</Button>
            </div>
          </>
        ) : (
          <>
            <p className="fitness-muted">选择复用已有模板或创建独立副本。官方更新不会覆盖你的修改。</p>
            {templates.isPending ? (
              <LoadingState label="正在检查已有模板副本…" />
            ) : templates.isError ? (
              <ErrorState error={templates.error} retry={() => void templates.refetch()} />
            ) : (
              referenced.map((sourceId) => (
                <Field
                  key={sourceId}
                  label={library.templates.find((item) => item.id === sourceId)?.name.zh ?? sourceId}
                >
                  <select
                    value={choices[sourceId] ?? ''}
                    disabled={mutation.isPending}
                    onChange={(event) => setChoices({ ...choices, [sourceId]: event.target.value })}
                  >
                    <option value="">创建新的模板副本</option>
                    {all
                      .filter(
                        (item) =>
                          item.catalog_origin?.source === 'official' && item.catalog_origin.item_id === sourceId,
                      )
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          复用：{item.name}
                        </option>
                      ))}
                  </select>
                </Field>
              ))
            )}
            {templates.hasNextPage && (
              <Button
                variant="secondary"
                disabled={templates.isFetchingNextPage || mutation.isPending}
                onClick={() => void templates.fetchNextPage()}
              >
                加载更多已有模板副本
              </Button>
            )}
            <p className="fitness-muted">
              {plan.cycle_days} 天一个周期，含 {plan.days.filter((day) => day.template_id).length}{' '}
              个训练日。首次导入为停用状态，可在我的计划中编辑并启用。
            </p>
            {mutation.isError && <ErrorState error={mutation.error} />}
            <div className="fitness-dialog-actions">
              <Button
                disabled={mutation.isPending || templates.isPending || templates.isError}
                onClick={() => {
                  const context = captureProductAnalyticsContext();
                  trackProductAction('fitness_plan_add_click', 'fitness.plans.library.detail', accountId, context);
                  mutation.mutate(context);
                }}
              >
                {mutation.isPending ? '正在添加…' : '添加到我的计划'}
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
