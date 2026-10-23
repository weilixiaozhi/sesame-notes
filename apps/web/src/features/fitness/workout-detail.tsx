import { useEffect, useRef, useState } from 'react';
import { ApiError, unwrap } from '@sesame-notes/api-client';
import { Check, Copy, Pause, Pencil, Play, Save, Timer, Trash2 } from 'lucide-react';
import { api, pushChange, type SyncChange } from '../../lib/session';
import { useProductAnalyticsPage } from '../../lib/use-product-analytics';
import {
  beginProductAnalyticsFlow,
  captureProductAnalyticsContext,
  trackProductAction,
  type ProductAnalyticsContext,
} from '../../lib/product-analytics-runtime';
import { rememberProductTrainingFlow, productTrainingFlow, forgetProductTrainingFlow } from './workout-analytics';
import { Button, Dialog, ErrorState, Field } from '../../components/ui';
import { ExercisesView } from './exercises-view';
import { changeRest, completeSet, restRemaining } from './rest-model';
import {
  workoutElapsed,
  transitionWorkout,
  workoutLabels,
  workoutPayload,
  type FitnessPreferences,
  type FitnessSpace,
  type FitnessTemplate,
  type TemplatePayload,
  type Workout,
  type WorkoutPayload,
} from './fitness-model';

/** 训练详情在每次写入携带版本，组完成、休息与计时更新共享同一事务载荷。 */
export function WorkoutDetail({
  workout,
  accountId,
  space,
  names,
  preferences,
  onClose,
  onEdit,
}: {
  workout: Workout;
  accountId?: string;
  space: FitnessSpace;
  names: Map<string, string>;
  preferences?: FitnessPreferences;
  onClose: () => void;
  onEdit: () => void;
}) {
  const analyticsAccountId = accountId ?? '';
  const [trainingFlow, setTrainingFlow] = useState(() =>
    workout.status === 'in_progress' ? productTrainingFlow(workout.id, analyticsAccountId) : null,
  );
  const finishContext = useRef<ProductAnalyticsContext | null>(null);
  useProductAnalyticsPage('fitness.workout', true, 2, trainingFlow);
  const [now, setNow] = useState(Date.now());
  const [seconds, setSeconds] = useState(String(preferences?.default_rest_seconds ?? 90));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmation, setConfirmation] = useState<'delete' | 'finish' | 'template' | 'update-template' | null>(null);
  const [templateName, setTemplateName] = useState(workout.name);
  const [notice, setNotice] = useState('');
  const [templateId, setTemplateId] = useState(() => crypto.randomUUID());
  const templateAttempt = useRef<{ signature: string; change: SyncChange } | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const alerted = useRef<string | null>(null);
  const remaining = restRemaining(workout.rest_timer, now);
  const elapsed = Math.floor(workoutElapsed(workout, now) / 1000);
  const elapsedLabel = [Math.floor(elapsed / 3600), Math.floor(elapsed / 60) % 60, elapsed % 60]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(
    () => () => {
      void audio.current?.close();
    },
    [],
  );
  useEffect(() => {
    const timer = workout.rest_timer;
    if (!timer || timer.status !== 'running' || remaining > 0) return;
    const key = `${timer.ends_at}:${timer.set_id ?? ''}`;
    if (alerted.current === key) return;
    alerted.current = key;
    if (preferences?.vibration_enabled !== false && navigator.vibrate) navigator.vibrate([120, 80, 120]);
    const context = audio.current;
    if (preferences?.sound_enabled !== false && context?.state === 'running') {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.frequency.value = 660;
      gain.gain.value = 0.08;
      oscillator.start();
      oscillator.stop(context.currentTime + 0.25);
    }
  }, [remaining, workout.rest_timer, preferences]);

  /** 用户点击后解锁音效，浏览器拒绝声音不会影响训练保存。 */
  function unlockAudio() {
    try {
      audio.current ??= new AudioContext();
      void audio.current.resume().catch(() => undefined);
    } catch {
      /* 不支持音频时仍有可见结束提醒。 */
    }
  }
  /** 在线操作复用统一错误反馈，失败时详情和待确认操作保留。 */
  async function perform(operation: () => Promise<void>) {
    if (busy) return;
    unlockAudio();
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  /** 真实开始或恢复训练后登记随机流程，关闭重开同一训练仍沿用已观察到的流程。 */
  function startRunning(): void {
    try {
      const retained = workout.status === 'in_progress' ? productTrainingFlow(workout.id, analyticsAccountId) : null;
      const context = retained ? captureProductAnalyticsContext(retained) : beginProductAnalyticsFlow();
      trackProductAction('fitness_workout_start_click', 'fitness.workout', analyticsAccountId, context);
      void perform(async () => {
        await save(transitionWorkout(workout, workout.status === 'in_progress' ? 'resume' : 'start'));
        rememberProductTrainingFlow(workout.id, context);
        setTrainingFlow(context);
        trackProductAction('fitness_workout_started', 'fitness.workout', analyticsAccountId, context);
      });
    } catch (error) {
      console.warn('[健身] 训练关联暂不可用', error);
      setError(error);
    }
  }
  /** 暂停点击和持久化成功分别记录，异步回执沿用触发时的账号与训练流。 */
  function pauseRunning(): void {
    const context = captureProductAnalyticsContext(productTrainingFlow(workout.id, analyticsAccountId));
    trackProductAction('fitness_workout_pause_click', 'fitness.workout', analyticsAccountId, context);
    void perform(async () => {
      await save(transitionWorkout(workout, 'pause'));
      trackProductAction('fitness_workout_paused', 'fitness.workout', analyticsAccountId, context);
    });
  }
  /** 保存当前详情的条件快照；旧页面不能覆盖其他设备的新计时。 */
  async function save(payload: WorkoutPayload) {
    await pushChange({
      mutation_id: crypto.randomUUID(),
      entity_type: 'fitness_workout',
      entity_id: workout.id,
      ledger_id: null,
      day_book_id: null,
      memo_book_id: null,
      fitness_space_id: space.id,
      sync_id: space.sync_id,
      base_revision: workout.revision,
      action: 'upsert',
      updated_at: payload.updated_at,
      payload,
    });
  }
  /** 来源模板按分页精确定位，删除后的来源不会被默默重新创建。 */
  async function sourceTemplate(): Promise<FitnessTemplate> {
    let cursor: string | undefined;
    do {
      const page = unwrap(
        await api.GET('/api/v1/fitness-spaces/{fitness_space_id}/templates', {
          params: { path: { fitness_space_id: space.id }, query: { limit: 200, ...(cursor ? { cursor } : {}) } },
        }),
      );
      const found = page.items.find((entry) => entry.id === workout.source_template_id);
      if (found) return found;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    throw new Error('来源模板已删除或不可访问，请另存为新模板。');
  }
  /** 训练另存为模板仅复制处方，完成与休息历史仍只属于原训练。 */
  async function saveTemplate(update: boolean) {
    if (!workout.exercises.length) throw new Error('至少添加一个动作后才能保存模板。');
    const signature = JSON.stringify({
      update,
      name: update ? null : templateName.trim(),
      source: workout.source_template_id,
      exercises: workout.exercises,
    });
    if (!templateAttempt.current || templateAttempt.current.signature !== signature) {
      const original = update ? await sourceTemplate() : undefined;
      const name = update ? original!.name : templateName.trim();
      if (!name || [...name].length > 100) throw new Error('模板名称需为 1–100 个字符。');
      const timestamp = new Date().toISOString();
      const payload: TemplatePayload = {
        name,
        exercises: workout.exercises.map((exercise) => ({
          id: crypto.randomUUID(),
          exercise_id: exercise.exercise_id,
          rest_seconds: exercise.rest_seconds,
          warmup_rest_seconds: exercise.warmup_rest_seconds,
          sets: exercise.sets.map((set) => ({
            id: crypto.randomUUID(),
            kind: set.kind,
            weight: set.weight,
            weight_left: set.weight_left,
            weight_right: set.weight_right,
            reps: set.reps,
          })),
        })),
        created_at: original?.created_at ?? timestamp,
        updated_at: timestamp,
        ...(original?.catalog_origin ? { catalog_origin: original.catalog_origin } : {}),
      };
      templateAttempt.current = {
        signature,
        change: {
          mutation_id: crypto.randomUUID(),
          entity_type: 'fitness_template',
          entity_id: original?.id ?? templateId,
          ledger_id: null,
          day_book_id: null,
          memo_book_id: null,
          fitness_space_id: space.id,
          sync_id: space.sync_id,
          base_revision: original?.revision ?? 0,
          action: 'upsert',
          updated_at: timestamp,
          payload,
        },
      };
    }
    try {
      await pushChange(templateAttempt.current.change);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status < 500) templateAttempt.current = null;
      throw failure;
    }
    templateAttempt.current = null;
    setTemplateId(crypto.randomUUID());
    setConfirmation(null);
    setNotice(update ? '来源模板已更新。' : '已保存到我的模板。');
  }
  /** 删除仅移除当前训练；计划安排的稳定身份仍由服务端维护，不能再重复生成。 */
  async function remove() {
    const context = productTrainingFlow(workout.id, analyticsAccountId);
    await pushChange({
      mutation_id: crypto.randomUUID(),
      entity_type: 'fitness_workout',
      entity_id: workout.id,
      ledger_id: null,
      day_book_id: null,
      memo_book_id: null,
      fitness_space_id: space.id,
      sync_id: space.sync_id,
      base_revision: workout.revision,
      action: 'delete',
      updated_at: new Date().toISOString(),
      payload: {},
    });
    forgetProductTrainingFlow(workout.id, context);
    onClose();
  }

  return (
    <>
      <Dialog
        open
        onClose={() => {
          if (!busy) onClose();
        }}
        title={workout.name}
        description={`${workout.scheduled_date} · ${workoutLabels[workout.status]}`}
      >
        <div className="fitness-form">
          <div className="fitness-detail-metrics">
            <span>
              <strong>{workout.exercises.length}</strong> 个动作
            </span>
            <span>
              <strong role="timer" aria-label={`累计训练时长 ${elapsedLabel}`}>
                {elapsedLabel}
              </strong>{' '}
              累计时长
            </span>
            <span>
              {workout.source_plan_name
                ? `来自计划：${workout.source_plan_name}`
                : workout.source_kind === 'template'
                  ? '来自个人模板'
                  : '自由训练'}
            </span>
          </div>
          {notice && (
            <p className="fitness-notice" role="status">
              {notice}
            </p>
          )}
          {error !== null && <ErrorState error={error} />}
          {workout.status === 'in_progress' && (
            <section className="fitness-rest-control">
              <div className="fitness-row">
                <h3>
                  <Timer size={18} />
                  组间休息
                </h3>
                <strong className="fitness-countdown" role="timer" aria-label={`休息剩余 ${remaining} 秒`}>
                  {String(Math.floor(remaining / 60)).padStart(2, '0')}:{String(remaining % 60).padStart(2, '0')}
                </strong>
              </div>
              {workout.rest_timer ? (
                <>
                  <p className="fitness-muted" role={remaining === 0 ? 'status' : undefined}>
                    {workout.rest_timer.status === 'paused'
                      ? '休息已暂停'
                      : remaining === 0
                        ? '休息结束，准备下一组。'
                        : '按云端时间持续计时，切换页面不会重置。'}
                  </p>
                  <div className="fitness-inline-actions">
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        void perform(() =>
                          save(
                            changeRest(
                              workoutPayload(workout),
                              workout.rest_timer?.status === 'running' ? 'pause' : 'resume',
                            ),
                          ),
                        )
                      }
                    >
                      {workout.rest_timer.status === 'running' ? '暂停休息' : '继续休息'}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void perform(() => save(changeRest(workoutPayload(workout), 'adjust', 15)))}
                    >
                      +15 秒
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void perform(() => save(changeRest(workoutPayload(workout), 'adjust', -15)))}
                    >
                      −15 秒
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() => void perform(() => save(changeRest(workoutPayload(workout), 'finish')))}
                    >
                      结束休息
                    </Button>
                  </div>
                </>
              ) : (
                <div className="fitness-add-exercise">
                  <Field label="休息秒数">
                    <input
                      inputMode="numeric"
                      value={seconds}
                      disabled={busy}
                      onChange={(event) => setSeconds(event.target.value)}
                    />
                  </Field>
                  <Button
                    variant="secondary"
                    disabled={busy || !/^\d+$/.test(seconds)}
                    onClick={() =>
                      void perform(() => save(changeRest(workoutPayload(workout), 'start', Number(seconds))))
                    }
                  >
                    开始休息
                  </Button>
                </div>
              )}
            </section>
          )}
          <ExercisesView exercises={workout.exercises} names={names} />
          {workout.exercises.some((entry) => entry.sets.length) && (
            <section className="fitness-form">
              <h3>完成训练组</h3>
              {workout.exercises.map((exercise) => (
                <div key={exercise.id} className="fitness-form">
                  <strong>{names.get(exercise.exercise_id) ?? exercise.exercise_id}</strong>
                  <div className="fitness-inline-actions">
                    {exercise.sets.map((set, index) => (
                      <Button
                        key={set.id}
                        variant={set.completed ? 'primary' : 'secondary'}
                        disabled={busy}
                        onClick={() =>
                          void perform(() =>
                            save(
                              completeSet(workoutPayload(workout), exercise.id, set.id, !set.completed, preferences),
                            ),
                          )
                        }
                      >
                        {set.completed && <Check size={14} />}第 {index + 1} 组{set.kind === 'warmup' ? ' · 热身' : ''}
                      </Button>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          )}
          <div className="fitness-dialog-actions">
            <Button variant="secondary" disabled={busy} onClick={onEdit}>
              <Pencil size={16} />
              编辑记录
            </Button>
            {workout.status !== 'in_progress' ? (
              <Button disabled={busy} onClick={startRunning}>
                <Play size={16} />
                {workout.status === 'completed' ? '继续训练' : '开始训练'}
              </Button>
            ) : (
              <>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    if (workout.run_segments.at(-1)?.ended_at !== null) startRunning();
                    else pauseRunning();
                  }}
                >
                  {workout.run_segments.at(-1)?.ended_at === null ? (
                    <>
                      <Pause size={16} />
                      暂停训练
                    </>
                  ) : (
                    <>
                      <Play size={16} />
                      继续训练
                    </>
                  )}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => {
                    finishContext.current = captureProductAnalyticsContext(
                      productTrainingFlow(workout.id, analyticsAccountId),
                    );
                    trackProductAction(
                      'fitness_workout_finish_click',
                      'fitness.workout',
                      analyticsAccountId,
                      finishContext.current,
                    );
                    setConfirmation('finish');
                  }}
                >
                  <Check size={16} />
                  完成训练
                </Button>
              </>
            )}
          </div>
          <div className="fitness-inline-actions">
            <Button variant="ghost" disabled={busy} onClick={() => setConfirmation('template')}>
              <Copy size={16} />
              另存为模板
            </Button>
            {workout.source_template_id && (
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmation('update-template')}>
                <Save size={16} />
                更新来源模板
              </Button>
            )}
            <Button variant="ghost" disabled={busy} onClick={() => setConfirmation('delete')}>
              <Trash2 size={16} />
              删除训练
            </Button>
          </div>
        </div>
      </Dialog>
      {confirmation && (
        <Dialog
          open
          onClose={() => {
            if (!busy) setConfirmation(null);
          }}
          title={
            confirmation === 'delete'
              ? '删除训练记录？'
              : confirmation === 'finish'
                ? '完成这次训练？'
                : confirmation === 'update-template'
                  ? '更新来源模板？'
                  : '另存为个人模板'
          }
          description={
            confirmation === 'delete'
              ? '这条训练记录将从云空间移除，并同步到其他设备。'
              : confirmation === 'finish'
                ? '当前运行时段与休息时间会结算到记录中。'
                : confirmation === 'update-template'
                  ? '将用当前训练动作和组替换来源模板处方，不改变已安排的其他训练。'
                  : '保存独立的动作和组配置，不复制完成状态。'
          }
        >
          <div className="fitness-form">
            {confirmation === 'template' && (
              <Field label="模板名称">
                <input
                  value={templateName}
                  maxLength={200}
                  disabled={busy}
                  onChange={(event) => setTemplateName(event.target.value)}
                />
              </Field>
            )}
            {error !== null && <ErrorState error={error} />}
            <div className="fitness-dialog-actions">
              <Button
                variant={confirmation === 'delete' ? 'danger' : 'primary'}
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    if (confirmation === 'delete') await remove();
                    else if (confirmation === 'finish') {
                      await save(transitionWorkout(workout, 'complete'));
                      trackProductAction(
                        'fitness_workout_completed',
                        'fitness.workout',
                        analyticsAccountId,
                        finishContext.current,
                      );
                      forgetProductTrainingFlow(workout.id, finishContext.current);
                      setTrainingFlow(null);
                      setConfirmation(null);
                    } else await saveTemplate(confirmation === 'update-template');
                  })
                }
              >
                {busy ? '正在保存…' : '确认'}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
