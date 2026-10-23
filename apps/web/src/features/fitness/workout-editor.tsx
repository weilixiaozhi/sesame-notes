import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowUp, ArrowDown, Plus, Trash2 } from 'lucide-react';
import { Button, Dialog, Field, ErrorState } from '../../components/ui';
import { useDraftClose } from '../../components/use-draft-close';
import { useSession } from '../../lib/session';
import { useProductAnalyticsPage } from '../../lib/use-product-analytics';
import {
  captureProductAnalyticsContext,
  trackProductAction,
  type ProductAnalyticsContext,
} from '../../lib/product-analytics-runtime';
import { completeSet } from './rest-model';
import { setExerciseWeightMode, usesSideWeight } from './weight-mode';
import { createWeightModeWriter } from './weight-mode-save';
import {
  localToday,
  newWorkout,
  validateWorkout,
  workoutPayload,
  type Catalog,
  type FitnessPreferences,
  type FitnessTemplate,
  type FitnessSpace,
  type Workout,
  type WorkoutExercise,
  type WorkoutPayload,
  type WorkoutSet,
} from './fitness-model';

const basics = z.object({
  name: z
    .string()
    .trim()
    .min(1, '请输入训练名称')
    .refine((value) => [...value].length <= 100, '名称最多 100 个字符'),
  date: z.string().min(1, '请选择日期'),
});

/** 字段编辑只修改对应值，保留未展示字段、组身份、训练历史及来源关系。 */
export function WorkoutEditor({
  open,
  onClose,
  workout,
  template,
  space,
  catalog,
  preferences,
  onSave,
  templateMode = false,
  initialDate,
  analyticsContext,
}: {
  open: boolean;
  onClose: () => void;
  workout?: Workout;
  template?: FitnessTemplate;
  space: FitnessSpace;
  catalog?: Catalog;
  preferences?: FitnessPreferences;
  onSave: (payload: WorkoutPayload, id: string, mutationId: string) => Promise<void>;
  templateMode?: boolean;
  initialDate?: string;
  analyticsContext?: ProductAnalyticsContext | null;
}) {
  const { session } = useSession();
  const analyticsAccountId = session?.user.user_id ?? '';
  const saveContext = useRef<ProductAnalyticsContext | null>(null);
  const analyticsPage = templateMode ? 'fitness.templates.edit' : 'fitness.workouts.editor';
  useProductAnalyticsPage(analyticsPage, open, 3, analyticsContext);
  const [id] = useState(() => workout?.id ?? (templateMode ? template?.id : undefined) ?? crypto.randomUUID());
  const [draft, setDraft] = useState(() =>
    workout
      ? workoutPayload(workout)
      : templateMode && template
        ? {
            ...newWorkout(template.name, localToday(), template),
            exercises: template.exercises.map((exercise) => ({
              ...exercise,
              sets: exercise.sets.map((set) => ({ ...set, completed: false, rest_durations_seconds: [] })),
            })),
          }
        : newWorkout(template?.name ?? '', initialDate ?? localToday(), template),
  );
  const [initialDraft] = useState(() => JSON.stringify(draft));
  const attempt = useRef<{ fingerprint: string; payload: WorkoutPayload; mutationId: string } | null>(null);
  const [exerciseId, setExerciseId] = useState('');
  const [replacing, setReplacing] = useState<{ instanceId: string; exerciseId: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [confirmedPreferences, setConfirmedPreferences] = useState<FitnessPreferences>();
  const [editingWeightModes, setEditingWeightModes] = useState<Record<string, boolean>>({});
  const [writeWeightMode] = useState(() => createWeightModeWriter(space));
  const effectivePreferences =
    confirmedPreferences && confirmedPreferences.revision > (preferences?.revision ?? 0)
      ? confirmedPreferences
      : preferences;
  const form = useForm<z.infer<typeof basics>>({
    resolver: zodResolver(basics),
    defaultValues: { name: draft.name, date: draft.scheduled_date },
  });
  const guard = useDraftClose(form.formState.isDirty || JSON.stringify(draft) !== initialDraft, busy, onClose);
  const exerciseOptions = [
    ...(catalog?.exercises
      .filter((entry) => entry.is_enabled !== false)
      .map((entry) => ({ id: entry.id, name: entry.name_zh })) ?? []),
    ...(preferences?.custom_exercises
      .filter((entry) => !entry.deleted)
      .map((entry) => ({ id: entry.id, name: entry.name })) ?? []),
  ];
  const names = new Map([
    ...(catalog?.exercises.map((entry) => [entry.id, entry.name_zh] as const) ?? []),
    ...exerciseOptions.map((entry) => [entry.id, entry.name] as const),
  ]);
  const replacementSource = draft.exercises.find((entry) => entry.id === replacing?.instanceId);

  /** 输入开始后固定当前动作口径，清空最后一组重量也不会切换输入框。 */
  function sideWeight(exerciseId: string) {
    return editingWeightModes[exerciseId] ?? usesSideWeight(draft.exercises, exerciseId, catalog, effectivePreferences);
  }

  /** 动作口径先保存空间偏好，成功后统一转换当前草稿里的全部同名动作实例。 */
  async function changeWeightMode(exercise: WorkoutExercise) {
    if (busy) return;
    const side = !sideWeight(exercise.exercise_id);
    setBusy(true);
    setError(null);
    try {
      const confirmed = await writeWeightMode(exercise.exercise_id, side);
      setConfirmedPreferences(confirmed);
      setEditingWeightModes((current) => ({ ...current, [exercise.exercise_id]: side }));
      setDraft((current) => ({
        ...current,
        exercises: setExerciseWeightMode(current.exercises, exercise.exercise_id, side),
      }));
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  /** 与手机替换规则一致：保留实例、组身份和组类型，清空原动作成绩，其他动作不变。 */
  function replaceExercise() {
    if (!replacing || !exerciseOptions.some((entry) => entry.id === replacing.exerciseId)) return;
    const target = replacing;
    setDraft((current) => ({
      ...current,
      exercises: current.exercises.map((entry) =>
        entry.id !== target.instanceId || entry.exercise_id === target.exerciseId
          ? entry
          : {
              ...entry,
              exercise_id: target.exerciseId,
              sets: entry.sets.map((set) => ({
                id: set.id,
                kind: set.kind,
                weight: null,
                weight_left: null,
                weight_right: null,
                reps: null,
                completed: false,
                rest_durations_seconds: [],
              })),
            },
      ),
    }));
    setReplacing(null);
  }

  /** 组字段按身份更新，索引变化不会把输入写进另一个动作。 */
  function updateSet(exercise: WorkoutExercise, set: WorkoutSet, patch: Partial<WorkoutSet>) {
    const side = sideWeight(exercise.exercise_id);
    setEditingWeightModes((current) => ({ ...current, [exercise.exercise_id]: side }));
    setDraft((current) => ({
      ...current,
      exercises: current.exercises.map((item) =>
        item.id === exercise.id
          ? {
              ...item,
              sets: item.sets.map((value) => (value.id === set.id ? { ...value, ...patch } : value)),
            }
          : item,
      ),
    }));
  }

  /** 拖动的键盘等价操作只交换顺序，保留动作及组的身份。 */
  function moveExercise(index: number, direction: number) {
    setDraft((current) => {
      const exercises = [...current.exercises];
      const item = exercises[index];
      const other = exercises[index + direction];
      if (!item || !other) return current;
      exercises[index] = other;
      exercises[index + direction] = item;
      return { ...current, exercises };
    });
  }

  /** 新动作默认只有一组未完成的自重草稿，用户可明确输入重量与次数。 */
  function addExercise() {
    if (!exerciseOptions.some((entry) => entry.id === exerciseId)) return;
    const exercise: WorkoutExercise = {
      id: crypto.randomUUID(),
      exercise_id: exerciseId,
      rest_seconds:
        preferences?.exercise_rest_settings?.[exerciseId]?.rest_seconds ?? preferences?.default_rest_seconds ?? 90,
      warmup_rest_seconds:
        preferences?.exercise_rest_settings?.[exerciseId]?.warmup_rest_seconds ??
        preferences?.default_warmup_rest_seconds ??
        null,
      sets: [newSet()],
    };
    setDraft((current) => ({ ...current, exercises: [...current.exercises, exercise] }));
    setExerciseId('');
  }

  /** 提交成功才关闭；冲突和网络错误保留完整输入供用户检查重试。 */
  async function submit(values: z.infer<typeof basics>) {
    if (busy) return;
    const context = saveContext.current;
    const payload = {
      ...draft,
      name: values.name,
      scheduled_date: workout?.scheduled_date ?? values.date,
      updated_at: new Date().toISOString(),
    };
    if (
      payload.rest_timer?.exercise_id &&
      !payload.exercises.some(
        (exercise) =>
          exercise.id === payload.rest_timer?.exercise_id &&
          exercise.sets.some((set) => set.id === payload.rest_timer?.set_id && set.completed),
      )
    )
      payload.rest_timer = { ...payload.rest_timer, exercise_id: null, set_id: null };
    const invalid = templateMode && !payload.exercises.length ? '模板至少需要一个动作。' : validateWorkout(payload);
    if (invalid) {
      setError(new Error(invalid));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fingerprint = JSON.stringify({ ...payload, updated_at: null });
      if (attempt.current?.fingerprint !== fingerprint)
        attempt.current = { fingerprint, payload, mutationId: crypto.randomUUID() };
      await onSave(attempt.current.payload, id, attempt.current.mutationId);
      trackProductAction(
        templateMode ? 'fitness_template_saved' : workout ? 'fitness_workout_updated' : 'fitness_workout_created',
        analyticsPage,
        analyticsAccountId,
        context,
      );
      guard.finish();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onClose={guard.close}
        title={templateMode ? (template ? '编辑个人模板' : '新建个人模板') : workout ? '编辑训练记录' : '安排训练'}
      >
        <form
          className="fitness-form"
          onSubmit={form.handleSubmit(submit)}
          onSubmitCapture={() => {
            if (!busy) {
              saveContext.current = captureProductAnalyticsContext(analyticsContext);
              trackProductAction(
                templateMode ? 'fitness_template_save_click' : 'fitness_workout_save_click',
                analyticsPage,
                analyticsAccountId,
                saveContext.current,
              );
            }
          }}
        >
          <div className="fitness-form-grid">
            <Field label={templateMode ? '模板名称' : '训练名称'} error={form.formState.errors.name?.message}>
              <input {...form.register('name')} autoFocus disabled={busy} maxLength={200} />
            </Field>
            {!templateMode && (
              <Field
                label="安排日期"
                error={form.formState.errors.date?.message}
                hint={workout ? '已有训练的安排日期保持不变' : undefined}
              >
                <input type="date" {...form.register('date')} disabled={busy || Boolean(workout)} />
              </Field>
            )}
          </div>
          <div className="fitness-editor-exercises">
            {draft.exercises.map((exercise, index) => (
              <section className="fitness-exercise-edit" key={exercise.id}>
                <div className="fitness-row">
                  <h3>
                    {index + 1}. {names.get(exercise.exercise_id) ?? exercise.exercise_id}
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`上移动作 ${index + 1}`}
                    disabled={busy || index === 0}
                    onClick={() => moveExercise(index, -1)}
                  >
                    <ArrowUp size={15} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`下移动作 ${index + 1}`}
                    disabled={busy || index === draft.exercises.length - 1}
                    onClick={() => moveExercise(index, 1)}
                  >
                    <ArrowDown size={15} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`删除动作 ${names.get(exercise.exercise_id) ?? index + 1}`}
                    disabled={busy}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        exercises: current.exercises.filter((entry) => entry.id !== exercise.id),
                      }))
                    }
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
                <div className="fitness-row">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`动作 ${index + 1} 重量口径`}
                    onClick={() => void changeWeightMode(exercise)}
                  >
                    {sideWeight(exercise.exercise_id) ? '单边重量' : '总重量'}
                  </Button>
                  <p className="fitness-muted">
                    组间休息 {exercise.rest_seconds} 秒
                    {exercise.warmup_rest_seconds !== null ? ` · 热身休息 ${exercise.warmup_rest_seconds} 秒` : ''}
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy || exerciseOptions.length === 0}
                    aria-label={`替换动作 ${names.get(exercise.exercise_id) ?? exercise.exercise_id}`}
                    onClick={() => setReplacing({ instanceId: exercise.id, exerciseId: '' })}
                  >
                    替换动作
                  </Button>
                </div>
                <div className="fitness-form-grid">
                  <Field label="正式组休息秒数">
                    <input
                      type="number"
                      min="0"
                      max="2147483647"
                      disabled={busy}
                      value={exercise.rest_seconds}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          exercises: current.exercises.map((item) =>
                            item.id === exercise.id ? { ...item, rest_seconds: Number(event.target.value) } : item,
                          ),
                        }))
                      }
                    />
                  </Field>
                  <Field label="热身组休息秒数" hint="留空沿用正式组">
                    <input
                      type="number"
                      min="0"
                      max="2147483647"
                      disabled={busy}
                      value={exercise.warmup_rest_seconds ?? ''}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          exercises: current.exercises.map((item) =>
                            item.id === exercise.id
                              ? {
                                  ...item,
                                  warmup_rest_seconds: event.target.value === '' ? null : Number(event.target.value),
                                }
                              : item,
                          ),
                        }))
                      }
                    />
                  </Field>
                </div>
                {exercise.sets.map((set, setIndex) => {
                  const side = sideWeight(exercise.exercise_id);
                  return (
                    <fieldset key={set.id} className="fitness-set-edit" disabled={busy}>
                      <legend>
                        第 {setIndex + 1} 组{set.kind === 'warmup' ? ' · 热身' : ''}
                      </legend>
                      <Field label="组类型">
                        <select
                          value={set.kind}
                          disabled={busy}
                          onChange={(event) =>
                            updateSet(exercise, set, { kind: event.target.value as WorkoutSet['kind'] })
                          }
                        >
                          <option value="working">正式组</option>
                          <option value="warmup">热身组</option>
                        </select>
                      </Field>
                      {side ? (
                        <>
                          <Field label="左侧 kg">
                            <input
                              aria-label={`动作 ${index + 1} 第 ${setIndex + 1} 组左侧重量`}
                              inputMode="decimal"
                              value={set.weight_left ?? ''}
                              onChange={(event) =>
                                updateSet(exercise, set, { weight: null, weight_left: event.target.value || null })
                              }
                            />
                          </Field>
                          <Field label="右侧 kg">
                            <input
                              aria-label={`动作 ${index + 1} 第 ${setIndex + 1} 组右侧重量`}
                              inputMode="decimal"
                              value={set.weight_right ?? ''}
                              onChange={(event) =>
                                updateSet(exercise, set, { weight: null, weight_right: event.target.value || null })
                              }
                            />
                          </Field>
                        </>
                      ) : (
                        <Field label="总重 kg（留空自重）">
                          <input
                            aria-label={`动作 ${index + 1} 第 ${setIndex + 1} 组重量`}
                            inputMode="decimal"
                            placeholder="自重"
                            value={set.weight ?? ''}
                            onChange={(event) =>
                              updateSet(exercise, set, {
                                weight: event.target.value || null,
                                weight_left: null,
                                weight_right: null,
                              })
                            }
                          />
                        </Field>
                      )}
                      <Field label="次数">
                        <input
                          type="number"
                          min="1"
                          max="2147483647"
                          step="1"
                          value={set.reps ?? ''}
                          onChange={(event) =>
                            updateSet(exercise, set, {
                              reps: event.target.value === '' ? null : Number(event.target.value),
                            })
                          }
                        />
                      </Field>
                      {!templateMode && (
                        <label className="fitness-check">
                          <input
                            type="checkbox"
                            checked={set.completed}
                            disabled={busy}
                            onChange={(event) => {
                              try {
                                setDraft(completeSet(draft, exercise.id, set.id, event.target.checked, preferences));
                                setError(null);
                              } catch (failure) {
                                setError(failure);
                              }
                            }}
                          />{' '}
                          已完成
                        </label>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={`删除第 ${setIndex + 1} 组`}
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            exercises: current.exercises.map((item) =>
                              item.id === exercise.id
                                ? { ...item, sets: item.sets.filter((entry) => entry.id !== set.id) }
                                : item,
                            ),
                          }))
                        }
                      >
                        <Trash2 size={15} />
                      </Button>
                    </fieldset>
                  );
                })}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || exercise.sets.length >= 1000}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      exercises: current.exercises.map((item) =>
                        item.id === exercise.id ? { ...item, sets: [...item.sets, newSet()] } : item,
                      ),
                    }))
                  }
                >
                  <Plus size={16} /> 添加一组
                </Button>
              </section>
            ))}
          </div>
          <div className="fitness-add-exercise">
            <Field label="添加动作">
              <select value={exerciseId} onChange={(event) => setExerciseId(event.target.value)} disabled={busy}>
                <option value="">选择动作</option>
                {exerciseOptions.map((entry) => (
                  <option value={entry.id} key={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </Field>
            <Button
              variant="secondary"
              disabled={!exerciseId || busy || draft.exercises.length >= 1000}
              onClick={addExercise}
            >
              <Plus size={16} /> 添加
            </Button>
          </div>
          {!templateMode && draft.status === 'scheduled' && (
            <p className="fitness-muted">勾选有效训练组会开始训练和组间休息。取消完成会清空该组休息历史。</p>
          )}
          {error !== null && <ErrorState error={error} />}
          <div className="fitness-dialog-actions">
            <Button type="submit" disabled={busy}>
              {busy ? '正在保存…' : templateMode ? '保存模板' : '保存训练'}
            </Button>
          </div>
        </form>
      </Dialog>
      {replacing && replacementSource && (
        <Dialog
          open
          title="替换动作"
          description={`${replacementSource.sets.some((set) => set.completed) ? '此动作已有完成组。' : ''}替换后将清空此动作的重量、次数、完成状态和休息成绩，保留组数与组类型；其他动作不变。`}
          onClose={() => setReplacing(null)}
        >
          <div className="fitness-form">
            <Field label="替换为">
              <select
                value={replacing.exerciseId}
                onChange={(event) => setReplacing({ ...replacing, exerciseId: event.target.value })}
              >
                <option value="">选择动作</option>
                {exerciseOptions
                  .filter((entry) => entry.id !== replacementSource.exercise_id)
                  .map((entry) => (
                    <option value={entry.id} key={entry.id}>
                      {entry.name}
                    </option>
                  ))}
              </select>
            </Field>
            <div className="fitness-dialog-actions">
              <Button
                disabled={!replacing.exerciseId || replacing.exerciseId === replacementSource.exercise_id}
                onClick={replaceExercise}
              >
                确认替换
              </Button>
            </div>
          </div>
        </Dialog>
      )}
      {guard.confirmation}
    </>
  );
}

/** 每一组拥有独立 UUID，并保留自重草稿的 null 重量语义。 */
function newSet(): WorkoutSet {
  return {
    id: crypto.randomUUID(),
    kind: 'working',
    weight: null,
    weight_left: null,
    weight_right: null,
    reps: null,
    completed: false,
    rest_durations_seconds: [],
  };
}
