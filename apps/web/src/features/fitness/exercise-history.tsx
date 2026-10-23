import { useInfiniteQuery } from '@tanstack/react-query';
import { unwrap } from '@sesame-notes/api-client';
import { ArrowDown, ArrowRight } from 'lucide-react';
import { api } from '../../lib/session';
import { Button, EmptyState, ErrorState, LoadingState } from '../../components/ui';
import { localToday, workoutLabels, workoutPayload, type FitnessSpace } from './fitness-model';
import { restRemaining, settleRest } from './rest-model';
import { ExercisesView } from './exercises-view';

/** 动作历史由服务端筛选后分页，包括正在训练中已经完成的组。 */
export function ExerciseHistory({
  space,
  userId,
  exerciseId,
  name,
  onWorkout,
}: {
  space: FitnessSpace;
  userId: string;
  exerciseId: string;
  name: string;
  onWorkout: (id: string) => void;
}) {
  const history = useInfiniteQuery({
    queryKey: ['account', userId, 'fitness', space.id, 'exercise-history', exerciseId],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      unwrap(
        await api.GET('/api/v1/fitness-spaces/{fitness_space_id}/workouts', {
          params: {
            path: { fitness_space_id: space.id },
            query: { limit: 20, exercise_id: exerciseId, ...(pageParam ? { cursor: pageParam } : {}) },
          },
          signal,
        }),
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const workouts = history.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section className="fitness-content">
      <h3>动作训练历史</h3>
      <p className="fitness-muted">按创建时间倒序，显示实际训练日期。</p>
      {history.isPending ? (
        <LoadingState label="正在读取动作历史…" />
      ) : history.isError ? (
        <ErrorState error={history.error} retry={() => void history.refetch()} />
      ) : !workouts.length ? (
        <EmptyState title="还没有完成组记录" description="完成该动作的训练组后会出现在这里。" />
      ) : (
        <>
          {workouts.map((workout) => {
            const payload = workoutPayload(workout);
            const historyLength =
              payload.exercises
                .find((exercise) => exercise.id === payload.rest_timer?.exercise_id)
                ?.sets.find((set) => set.id === payload.rest_timer?.set_id)?.rest_durations_seconds?.length ?? 0;
            const view =
              payload.rest_timer && historyLength < 1000 && restRemaining(payload.rest_timer, Date.now()) === 0
                ? settleRest(payload, Date.now())
                : payload;
            const date = workout.run_segments[0]
              ? localToday(new Date(workout.run_segments[0].started_at))
              : workout.scheduled_date;
            return (
              <article className="fitness-plan-day" key={workout.id}>
                <div className="fitness-section-heading">
                  <div>
                    <strong>{workout.name}</strong>
                    <p>
                      {date} · {workoutLabels[workout.status]}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onWorkout(workout.id)}
                    aria-label={`打开训练 ${workout.name}`}
                  >
                    <ArrowRight size={17} />
                  </Button>
                </div>
                <ExercisesView
                  names={new Map([[exerciseId, name]])}
                  exercises={view.exercises
                    .filter((exercise) => exercise.exercise_id === exerciseId)
                    .map((exercise) => ({ ...exercise, sets: exercise.sets.filter((set) => set.completed) }))}
                />
              </article>
            );
          })}
          {history.hasNextPage && (
            <Button
              variant="secondary"
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              <ArrowDown size={16} />
              {history.isFetchingNextPage ? '正在加载…' : '加载更早记录'}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
