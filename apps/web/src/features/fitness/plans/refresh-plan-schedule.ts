import { useEffect, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError, unwrap, type paths } from '@sesame-notes/api-client';
import { captureSessionOperation, queryClient } from '../../../lib/session';
import { localToday, type FitnessPlan, type FitnessSpace } from '../fitness-model';

type Command =
  paths['/api/v1/fitness-spaces/{fitness_space_id}/plans/{plan_id}/command']['post']['requestBody']['content']['application/json'];

/** 完整分页读计划，不能因为首屏没有启用计划就漏掉后续排班。 */
async function readPlans(
  space: FitnessSpace,
  operation: ReturnType<typeof captureSessionOperation>,
): Promise<FitnessPlan[]> {
  const all: FitnessPlan[] = [];
  let cursor: string | undefined;
  do {
    operation.assertCurrent();
    const page = unwrap(
      await operation.client.GET('/api/v1/fitness-spaces/{fitness_space_id}/plans', {
        params: { path: { fitness_space_id: space.id }, query: { limit: 200, sync_id: space.sync_id, cursor } },
      }),
    );
    operation.assertCurrent();
    all.push(...page.items);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return all;
}

/** 只生成尚未生成的到期周期；并发版本冲突重读一次，网络重试保留冻结命令。 */
export async function refreshFitnessSchedule(
  space: FitnessSpace,
  userId: string,
  attempts: Map<string, Command>,
  today = localToday(),
): Promise<{ hasMore: boolean }> {
  const operation = captureSessionOperation();
  const plans = await readPlans(space, operation);
  let hasMore = false;
  let changed = false;
  try {
    for (const initial of plans) {
      let plan = initial;
      for (let retry = 0; retry < 2; retry++) {
        operation.assertCurrent();
        if (
          plan.status !== 'in_progress' ||
          (plan.generation_state.next_cycle_start_date !== null && plan.generation_state.next_cycle_start_date > today)
        )
          break;
        const key = `${plan.id}:${plan.revision}:${today}`;
        let body = attempts.get(key);
        if (!body) {
          body = {
            mutation_id: crypto.randomUUID(),
            sync_id: space.sync_id,
            base_revision: plan.revision,
            today,
            action: 'generate',
          };
          attempts.set(key, body);
        }
        try {
          const response = unwrap(
            await operation.client.POST('/api/v1/fitness-spaces/{fitness_space_id}/plans/{plan_id}/command', {
              params: { path: { fitness_space_id: space.id, plan_id: plan.id } },
              body,
            }),
          );
          operation.assertCurrent();
          attempts.delete(key);
          changed = true;
          hasMore ||= response.has_more;
          break;
        } catch (error) {
          operation.assertCurrent();
          if (!(
            error instanceof ApiError &&
            error.status === 409 &&
            error.code === 'FITNESS_PLAN_CHANGED' &&
            retry === 0
          ))
            throw error;
          attempts.delete(key);
          const latest = (await readPlans(space, operation)).find((entry) => entry.id === plan.id);
          if (!latest) break;
          plan = latest;
        }
      }
    }
    return { hasMore };
  } finally {
    if (changed && !operation.signal.aborted) {
      operation.assertCurrent();
      await queryClient.invalidateQueries({ queryKey: ['account', userId, 'fitness', space.id] });
    }
  }
}

/** 每次进入空间仅启动一轮生成，查询失效不会触发无限写入；超长历史可主动继续补齐。 */
export function useRefreshFitnessSchedule(space: FitnessSpace, userId: string) {
  const attempts = useRef(new Map<string, Command>());
  const started = useRef('');
  const refresh = useMutation({ mutationFn: () => refreshFitnessSchedule(space, userId, attempts.current) });
  const scope = `${userId}:${space.id}:${space.sync_id}`;
  const { mutate } = refresh;
  useEffect(() => {
    if (started.current === scope) return;
    started.current = scope;
    mutate();
  }, [scope, mutate]);
  return {
    pending: refresh.isPending,
    error: refresh.error,
    hasMore: refresh.data?.hasMore ?? false,
    retry: () => mutate(),
  };
}
