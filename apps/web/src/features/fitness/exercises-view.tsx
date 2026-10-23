import { Check } from 'lucide-react';
import type { WorkoutPayload, TemplatePayload } from './fitness-model';

/** 展示所有重量口径，未知动作保留原始标识以便与客户端核对。 */
export function ExercisesView({
  exercises,
  names,
}: {
  exercises: WorkoutPayload['exercises'] | TemplatePayload['exercises'];
  names: Map<string, string>;
}) {
  if (!exercises.length) return <p className="fitness-muted">尚未安排动作，可编辑训练添加。</p>;
  return (
    <div className="fitness-exercise-list">
      {exercises.map((exercise, index) => (
        <section key={exercise.id}>
          <h3>
            {index + 1}. {names.get(exercise.exercise_id) ?? exercise.exercise_id}
          </h3>
          <p className="fitness-muted">组间休息 {exercise.rest_seconds} 秒</p>
          <div className="fitness-sets-view">
            {exercise.sets.map((set, setIndex) => (
              <div key={set.id}>
                <span>
                  {setIndex + 1}
                  {set.kind === 'warmup' ? ' · 热身' : ''}
                </span>
                <span>
                  {set.weight !== null
                    ? `${set.weight} kg`
                    : set.weight_left !== null || set.weight_right !== null
                      ? `左 ${set.weight_left ?? '—'} / 右 ${set.weight_right ?? '—'} kg`
                      : '自重'}
                </span>
                <span>{set.reps ?? '—'} 次</span>
                {'completed' in set && set.completed ? <Check size={16} aria-label="已完成" /> : <span />}
                {'rest_durations_seconds' in set && set.rest_durations_seconds?.length ? (
                  <small className="fitness-history-rest">
                    休息记录：{set.rest_durations_seconds.map((seconds) => `${seconds} 秒`).join(' / ')}
                  </small>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
