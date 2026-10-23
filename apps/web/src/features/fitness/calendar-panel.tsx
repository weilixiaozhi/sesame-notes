import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { unwrap } from '@sesame-notes/api-client';
import { ChevronLeft, ChevronRight, Plus, ArrowRight, Leaf } from 'lucide-react';
import { api } from '../../lib/session';
import { Button, EmptyState, ErrorState, Field, LoadingState } from '../../components/ui';
import { localToday, validDate, workoutLabels, type FitnessSpace } from './fitness-model';
import { calendarRange, shiftPeriod } from './statistics-model';

/** 日历同时展示安排、跨日执行和计划休息日；所有条目来自完整范围查询。 */
export function FitnessCalendarPanel({
  space,
  userId,
  onWorkout,
  onCreate,
}: {
  space: FitnessSpace;
  userId: string;
  onWorkout: (id: string) => void;
  onCreate: (date: string) => void;
}) {
  const [params, setParams] = useSearchParams();
  const today = localToday();
  const requestedDate = params.get('date') ?? '';
  const requestedMonth = `${params.get('month') ?? ''}-01`;
  const validSelection = validDate(requestedDate) ? requestedDate : undefined;
  const anchor = validDate(requestedMonth) ? requestedMonth : (validSelection ?? today);
  const range = calendarRange(anchor);
  const selected =
    validSelection && validSelection >= range.start && validSelection <= range.end
      ? validSelection
      : anchor.slice(0, 7) === today.slice(0, 7)
        ? today
        : range.monthStart;
  const previousMonth = shiftPeriod('month', anchor, -1);
  const nextMonth = shiftPeriod('month', anchor, 1);
  /** 日期导航只更新自己的参数，保留当前空间、页签和训练详情上下文。 */
  function navigateDate(date: string, month = anchor.slice(0, 7)) {
    if (!validDate(date) || !validDate(`${month}-01`)) return;
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set('month', month);
      next.set('date', date);
      return next;
    });
  }
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const calendar = useQuery({
    queryKey: ['account', userId, 'fitness', space.id, 'calendar', range.start, range.end, timeZone],
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/fitness-spaces/{fitness_space_id}/calendar', {
          params: {
            path: { fitness_space_id: space.id },
            query: { start_date: range.start, end_date: range.end, time_zone: timeZone },
          },
          signal,
        }),
      ),
  });
  const days = new Map(calendar.data?.days.map((day) => [day.date, day]));
  const current = days.get(selected);
  return (
    <section className="fitness-content">
      <div className="fitness-section-heading">
        <h2>训练日历</h2>
        <Button onClick={() => onCreate(selected)}>
          <Plus size={17} />
          安排训练
        </Button>
      </div>
      <div className="fitness-date-navigation">
        <Button
          variant="secondary"
          aria-label="上个月"
          disabled={!validDate(previousMonth)}
          onClick={() => navigateDate(previousMonth, previousMonth.slice(0, 7))}
        >
          <ChevronLeft size={18} />
        </Button>
        <Field label="日历月份">
          <input
            type="month"
            min="0001-01"
            max="9999-12"
            value={anchor.slice(0, 7)}
            onChange={(event) => {
              const date = `${event.target.value}-01`;
              navigateDate(date, event.target.value);
            }}
          />
        </Field>
        <Button
          variant="secondary"
          aria-label="下个月"
          disabled={!validDate(nextMonth)}
          onClick={() => navigateDate(nextMonth, nextMonth.slice(0, 7))}
        >
          <ChevronRight size={18} />
        </Button>
        <Button variant="ghost" onClick={() => navigateDate(today, today.slice(0, 7))}>
          今天
        </Button>
      </div>
      {calendar.isPending ? (
        <LoadingState label="正在加载训练日历…" />
      ) : calendar.isError ? (
        <ErrorState error={calendar.error} retry={() => void calendar.refetch()} />
      ) : (
        <>
          <div className="fitness-calendar" aria-label={`${anchor.slice(0, 7)}训练日历`}>
            {['一', '二', '三', '四', '五', '六', '日'].map((day) => (
              <div className="fitness-calendar-weekday" key={day}>
                周{day}
              </div>
            ))}
            {range.dates.map((date) => {
              const day = days.get(date);
              const workoutCount = day?.workouts.length ?? 0;
              const restCount = day?.rest_days.length ?? 0;
              return (
                <button
                  type="button"
                  key={date}
                  className={`fitness-calendar-day ${date < range.monthStart || date > range.monthEnd ? 'is-outside' : ''}`}
                  aria-label={`${date}，${workoutCount}次训练，${restCount}项休息安排`}
                  aria-pressed={selected === date}
                  aria-current={date === localToday() ? 'date' : undefined}
                  onClick={() => navigateDate(date)}
                >
                  <span>{Number(date.slice(8))}</span>
                  <div className="fitness-calendar-marks">
                    {!!workoutCount && <span>{workoutCount} 训练</span>}
                    {!!restCount && <span className="fitness-rest-mark">休息</span>}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="fitness-section-heading">
            <h3>{selected} 的安排</h3>
            <span className="fitness-muted">{timeZone}</span>
          </div>
          {!current?.workouts.length && !current?.rest_days.length ? (
            <EmptyState
              title="这一天暂无训练安排"
              action={
                <Button variant="secondary" onClick={() => onCreate(selected)}>
                  安排这一天的训练
                </Button>
              }
            />
          ) : (
            <div className="fitness-workout-list">
              {current?.workouts.map((workout) => (
                <button
                  type="button"
                  key={workout.id}
                  className="fitness-workout-row fitness-workout-row-text"
                  onClick={() => onWorkout(workout.id)}
                >
                  <span className="fitness-row-main">
                    <strong>{workout.name}</strong>
                    <span>
                      {workout.source_plan_name ?? '独立训练'} · 安排 {workout.scheduled_date}
                      {workout.workout_date !== workout.scheduled_date ? ` · 实际开始 ${workout.workout_date}` : ''}
                    </span>
                  </span>
                  <span className={`fitness-status fitness-status-${workout.status}`}>
                    {workoutLabels[workout.status]}
                  </span>
                  <ArrowRight size={17} />
                </button>
              ))}
              {current?.rest_days.map((rest) => (
                <div className="fitness-workout-row fitness-rest-row" key={rest.source_plan_id}>
                  <span className="fitness-row-icon">
                    <Leaf size={20} />
                  </span>
                  <span className="fitness-row-main">
                    <strong>休息日</strong>
                    <span>{rest.source_plan_name}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
