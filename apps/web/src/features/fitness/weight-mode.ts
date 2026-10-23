import type { Catalog, FitnessPreferences, WorkoutExercise, WorkoutSet } from './fitness-types';

/** 同动作各实例共用已有成绩的口径，全部空白时才取显式偏好和器械默认值。 */
export function usesSideWeight(
  exercises: WorkoutExercise[],
  exerciseId: string,
  catalog?: Catalog,
  preferences?: FitnessPreferences,
): boolean {
  const sets = exercises.filter((exercise) => exercise.exercise_id === exerciseId).flatMap((exercise) => exercise.sets);
  if (sets.some((set) => set.weight_left !== null || set.weight_right !== null)) return true;
  if (sets.some((set) => set.weight !== null)) return false;
  const preferred = preferences?.exercise_weight_modes[exerciseId];
  if (preferred !== undefined) return preferred;
  const equipment =
    catalog?.exercises.find((entry) => entry.id === exerciseId)?.equipment ??
    preferences?.custom_exercises.find((entry) => entry.id === exerciseId)?.equipment;
  return equipment === 'dumbbell' || equipment === 'kettlebell';
}

/** 切换口径统一更新当前草稿中同一动作的全部实例，保留组身份、次数和训练历史。 */
export function setExerciseWeightMode(
  exercises: WorkoutExercise[],
  exerciseId: string,
  side: boolean,
): WorkoutExercise[] {
  return exercises.map((exercise) =>
    exercise.exercise_id === exerciseId
      ? {
          ...exercise,
          sets: exercise.sets.map((set) =>
            side
              ? {
                  ...set,
                  weight: null,
                  weight_left: set.weight_left ?? set.weight,
                  weight_right: set.weight_right ?? set.weight,
                }
              : { ...set, weight_left: null, weight_right: null },
          ),
        }
      : exercise,
  );
}

/** 有重量的组明确口径；空白或自重组不与同动作其他组的口径冲突。 */
export function setWeightMode(set: Pick<WorkoutSet, 'weight' | 'weight_left' | 'weight_right'>): boolean | null {
  if (set.weight_left !== null || set.weight_right !== null) return true;
  return set.weight !== null ? false : null;
}
