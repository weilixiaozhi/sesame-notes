import { ExerciseHistory } from './exercise-history';
import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { unwrap } from '@sesame-notes/api-client';
import { Pencil, Plus, Search, Settings2, Star, Trash2 } from 'lucide-react';
import { Button, Dialog, EmptyState, ErrorState, Field, LoadingState } from '../../components/ui';
import { api, pushChange, type SyncChange } from '../../lib/session';
import { useDraftClose } from '../../components/use-draft-close';
import { useProductAnalyticsPage } from '../../lib/use-product-analytics';
import {
  deleteCustomExercise,
  exerciseImage,
  preferencesPayload,
  type CustomExercise,
  type PreferencesPayload,
} from './preferences-model';
import type { Catalog, FitnessPreferences, FitnessSpace } from './fitness-model';
import { ExerciseMedia, ExerciseThumbnail } from './exercise-media';
import { taxonomyChoices, taxonomyLabels } from './taxonomy';
import { usesSideWeight } from './weight-mode';

/** 官方目录和空间自定义动作共同展示，隐藏动作仍保留在历史训练的名称字典中。 */
export function ExercisesPanel({
  space,
  userId,
  catalog,
  onWorkout,
}: {
  space: FitnessSpace;
  userId: string;
  catalog?: Catalog;
  onWorkout: (id: string) => void;
}) {
  const [keyword, setKeyword] = useState('');
  const [preferencesCreatedAt] = useState(() => new Date().toISOString());
  const attempts = useRef(
    new Map<string, Extract<SyncChange, { entity_type: 'fitness_preferences'; action: 'upsert' }>>(),
  );
  const [part, setPart] = useState('');
  const [customOnly, setCustomOnly] = useState(false);
  const [limit, setLimit] = useState(40);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ exercise?: CustomExercise; snapshot?: FitnessPreferences } | null>(null);
  const [settings, setSettings] = useState<{ snapshot?: FitnessPreferences; exerciseId?: string } | null>(null);
  const [removing, setRemoving] = useState<CustomExercise | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
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
  const snapshot = preferences.data?.items[0];
  const bodyPartLabels = taxonomyLabels(catalog, 'body_parts');
  const equipmentLabels = taxonomyLabels(catalog, 'equipment');
  const custom = snapshot?.custom_exercises.filter((entry) => !entry.deleted) ?? [];
  const names = new Map([
    ...(catalog?.exercises.map((entry) => [entry.id, entry.name_zh] as const) ?? []),
    ...custom.map((entry) => [entry.id, entry.name] as const),
  ]);
  const entries = useMemo(() => {
    const official = (catalog?.exercises ?? [])
      .filter((exercise) => exercise.is_enabled !== false)
      .map((exercise) => ({
        id: exercise.id,
        name: exercise.name_zh,
        english: exercise.name_en,
        part: exercise.body_part,
        equipment: exercise.equipment,
        custom: false,
        media: exercise.media_url,
      }));
    const mine = (snapshot?.custom_exercises ?? [])
      .filter((exercise) => !exercise.deleted)
      .map((exercise) => ({
        id: exercise.id,
        name: exercise.name,
        english: '',
        part: exercise.body_part,
        equipment: exercise.equipment,
        custom: true,
        media: undefined,
      }));
    const search = keyword.trim().toLocaleLowerCase();
    return [...mine, ...official]
      .filter(
        (entry) =>
          (!customOnly || entry.custom) &&
          (!part || entry.part === part) &&
          (!search || [entry.name, entry.english].some((text) => text.toLocaleLowerCase().includes(search))),
      )
      .sort(
        (a, b) =>
          Number(snapshot?.pinned_exercise_ids.includes(b.id) ?? false) -
          Number(snapshot?.pinned_exercise_ids.includes(a.id) ?? false),
      );
  }, [catalog, snapshot, keyword, part, customOnly]);
  const official = catalog?.exercises.find((entry) => entry.id === selected);
  const own = custom.find((entry) => entry.id === selected);
  useProductAnalyticsPage('fitness.exercise', Boolean(official || own));

  /** 偏好更新绑定打开时的版本，任何跨端冲突都要求用户重新确认。 */
  async function write(payload: PreferencesPayload, previous?: FitnessPreferences) {
    const normalized = {
      ...payload,
      created_at: previous?.created_at ?? preferencesCreatedAt,
      updated_at: new Date().toISOString(),
    };
    const fingerprint = JSON.stringify({
      revision: previous?.revision ?? 0,
      payload: { ...normalized, updated_at: null },
    });
    let attempt = attempts.current.get(fingerprint);
    if (!attempt) {
      attempt = {
        mutation_id: crypto.randomUUID(),
        entity_type: 'fitness_preferences',
        entity_id: space.id,
        ledger_id: null,
        day_book_id: null,
        memo_book_id: null,
        fitness_space_id: space.id,
        sync_id: space.sync_id,
        base_revision: previous?.revision ?? 0,
        action: 'upsert',
        updated_at: normalized.updated_at,
        payload: normalized,
      };
      attempts.current.set(fingerprint, attempt);
    }
    await pushChange(attempt);
    attempts.current.delete(fingerprint);
  }
  /** 独立点击操作在成功前禁用，失败不隐藏现有内容。 */
  async function perform(operation: () => Promise<void>) {
    if (busy) return;
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
  /** 置顶沿用空间偏好，官方与自定义动作采用相同稳定标识。 */
  async function pin(id: string) {
    const payload = preferencesPayload(snapshot);
    payload.pinned_exercise_ids = payload.pinned_exercise_ids.includes(id)
      ? payload.pinned_exercise_ids.filter((entry) => entry !== id)
      : [...payload.pinned_exercise_ids, id];
    await write(payload, snapshot);
  }

  return (
    <div className="fitness-content">
      <div className="fitness-section-heading">
        <h2>动作库</h2>
        <div className="fitness-inline-actions">
          <Button
            variant="secondary"
            disabled={preferences.isPending || preferences.isError}
            onClick={() => setSettings({ snapshot })}
          >
            <Settings2 size={16} />
            训练偏好
          </Button>
          <Button disabled={preferences.isPending || preferences.isError} onClick={() => setEditing({ snapshot })}>
            <Plus size={16} />
            自定义动作
          </Button>
        </div>
      </div>
      {preferences.isPending ? (
        <LoadingState label="正在读取空间偏好…" />
      ) : preferences.isError ? (
        <ErrorState error={preferences.error} retry={() => void preferences.refetch()} />
      ) : (
        <>
          <div className="fitness-search-bar">
            <Field label="搜索动作">
              <div className="fitness-search-input">
                <Search size={17} />
                <input
                  value={keyword}
                  onChange={(event) => {
                    setKeyword(event.target.value);
                    setLimit(40);
                  }}
                  placeholder="动作名称"
                />
              </div>
            </Field>
            <Field label="身体部位">
              <select
                value={part}
                onChange={(event) => {
                  setPart(event.target.value);
                  setLimit(40);
                }}
              >
                <option value="">全部部位</option>
                {Object.entries(bodyPartLabels).map(([key, label]) => (
                  <option value={key} key={key}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <label className="fitness-check">
              <input
                type="checkbox"
                checked={customOnly}
                onChange={(event) => {
                  setCustomOnly(event.target.checked);
                  setLimit(40);
                }}
              />
              只看自定义
            </label>
          </div>
          {error !== null && <ErrorState error={error} />}
          {entries.length ? (
            <>
              <div className="fitness-card-grid fitness-exercise-grid">
                {entries.slice(0, limit).map((entry) => (
                  <button
                    type="button"
                    key={entry.id}
                    className="fitness-template-card fitness-exercise-card"
                    onClick={() => setSelected(entry.id)}
                  >
                    <ExerciseThumbnail
                      key={`${entry.id}:${entry.media ?? ''}`}
                      name={entry.name}
                      source={entry.media}
                    />
                    <h3>
                      {snapshot?.pinned_exercise_ids.includes(entry.id) && <Star size={14} aria-label="已置顶" />}
                      {entry.name}
                    </h3>
                    <p>
                      {Object.entries(bodyPartLabels).find(([key]) => key === entry.part)?.[1] ?? entry.part} ·{' '}
                      {Object.entries(equipmentLabels).find(([key]) => key === entry.equipment)?.[1] ?? entry.equipment}
                      {entry.custom ? ' · 自定义' : ''}
                    </p>
                  </button>
                ))}
              </div>
              {entries.length > limit && (
                <div className="fitness-load-more">
                  <Button variant="secondary" onClick={() => setLimit((current) => current + 40)}>
                    加载更多（已显示 {Math.min(limit, entries.length)} / {entries.length}）
                  </Button>
                </div>
              )}
            </>
          ) : (
            <EmptyState title="没有找到匹配动作" description="尝试其他关键词或身体部位。" />
          )}
        </>
      )}
      {(official || own) && (
        <Dialog
          open
          onClose={() => {
            if (!busy) setSelected(null);
          }}
          title={names.get(selected!) ?? '动作详情'}
          description={`${bodyPartLabels[(official ?? own)!.body_part] ?? (official ?? own)!.body_part} · ${equipmentLabels[(official ?? own)!.equipment] ?? (official ?? own)!.equipment}`}
        >
          <div className="fitness-form">
            {own?.image && exerciseImage(own.image) && (
              <img className="fitness-exercise-image" src={exerciseImage(own.image)} alt={own.name} />
            )}
            {official && (
              <>
                <ExerciseMedia
                  key={`${official.id}:${official.media_url ?? ''}`}
                  name={official.name_zh}
                  source={official.media_url}
                />
                <ol className="fitness-instructions">
                  {official.instructions_zh.map((instruction, index) => (
                    <li key={index}>{instruction}</li>
                  ))}
                </ol>
              </>
            )}
            <ExerciseHistory
              space={space}
              userId={userId}
              exerciseId={selected!}
              name={names.get(selected!) ?? selected!}
              onWorkout={(id) => {
                setSelected(null);
                onWorkout(id);
              }}
            />
            {error !== null && <ErrorState error={error} />}
            <div className="fitness-dialog-actions">
              <Button variant="secondary" disabled={busy} onClick={() => void perform(() => pin(selected!))}>
                <Star size={16} />
                {snapshot?.pinned_exercise_ids.includes(selected!) ? '取消置顶' : '置顶动作'}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setSettings({ snapshot, exerciseId: selected! });
                  setSelected(null);
                }}
              >
                <Settings2 size={16} />
                动作设置
              </Button>
              {own && (
                <>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      setEditing({ exercise: own, snapshot });
                      setSelected(null);
                    }}
                  >
                    <Pencil size={16} />
                    编辑
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() => {
                      setRemoving(own);
                      setSelected(null);
                    }}
                  >
                    <Trash2 size={16} />
                    删除
                  </Button>
                </>
              )}
            </div>
          </div>
        </Dialog>
      )}
      {editing && (
        <CustomEditor
          catalog={catalog}
          exercise={editing.exercise}
          snapshot={editing.snapshot}
          onClose={() => setEditing(null)}
          onSave={(payload) => write(payload, editing.snapshot)}
        />
      )}
      {settings && (
        <PreferencesEditor
          catalog={catalog}
          snapshot={settings.snapshot}
          exerciseId={settings.exerciseId}
          exerciseName={names.get(settings.exerciseId ?? '')}
          onClose={() => setSettings(null)}
          onSave={(payload) => write(payload, settings.snapshot)}
        />
      )}
      {removing && (
        <Dialog
          open
          title="删除自定义动作？"
          description={`“${removing.name}”将隐藏，历史训练仍可识别名称。动作图片与置顶设置会清除。`}
          onClose={() => {
            if (!busy) setRemoving(null);
          }}
        >
          <div className="fitness-form">
            {error !== null && <ErrorState error={error} />}
            <div className="fitness-dialog-actions">
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await write(deleteCustomExercise(preferencesPayload(snapshot), removing.id), snapshot);
                    setRemoving(null);
                  })
                }
              >
                {busy ? '正在删除…' : '确认删除动作'}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/** 自定义动作表单保留图标、图片和稳定身份，图片在设备上缩小后才上传。 */
function CustomEditor({
  catalog,
  exercise,
  snapshot,
  onClose,
  onSave,
}: {
  catalog?: Catalog;
  exercise?: CustomExercise;
  snapshot?: FitnessPreferences;
  onClose: () => void;
  onSave: (payload: PreferencesPayload) => Promise<void>;
}) {
  useProductAnalyticsPage('fitness.exercises.edit', true, 3);
  const parts = taxonomyChoices(catalog, 'body_parts', exercise?.body_part);
  const equipment = taxonomyChoices(catalog, 'equipment', exercise?.equipment);
  const [initial] = useState<CustomExercise>(
    () =>
      exercise ?? {
        id: `custom:${crypto.randomUUID()}`,
        name: '',
        body_part: parts.find((entry) => entry.id === 'chest')?.id ?? parts[0]?.id ?? '',
        equipment: equipment.find((entry) => entry.id === 'body weight')?.id ?? equipment[0]?.id ?? '',
        icon: 'dumbbell',
        image: null,
        deleted: false,
      },
  );
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const guard = useDraftClose(JSON.stringify(draft) !== JSON.stringify(initial), busy, onClose);
  /** 浏览器解码后转为小尺寸 JPEG，拒绝无法解码或超过契约容量的文件。 */
  async function selectImage(file?: File) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('请选择小于 10 MB 的图片。');
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('浏览器无法处理图片。');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const base64 = canvas.toDataURL('image/jpeg', 0.65).split(',')[1];
      if (!base64 || base64.length > 65536) throw new Error('图片仍然过大，请选择更简单的图片。');
      setDraft((current) => ({ ...current, image: base64 }));
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  /** 只替换当前动作定义，其余自定义动作和偏好维持原样。 */
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!draft.name.trim() || [...draft.name.trim()].length > 100) {
      setError(new Error('动作名称需为 1–100 个字符。'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (
        !parts.some((entry) => entry.id === draft.body_part) ||
        !equipment.some((entry) => entry.id === draft.equipment)
      )
        throw new Error('请选择可用的身体部位和训练器械。');
      const payload = preferencesPayload(snapshot);
      const value = { ...draft, name: draft.name.trim() };
      const exists = payload.custom_exercises.some((entry) => entry.id === value.id);
      payload.custom_exercises = exists
        ? payload.custom_exercises.map((entry) => (entry.id === value.id ? value : entry))
        : [...payload.custom_exercises, value];
      if (
        payload.custom_exercises.length > 1000 ||
        new TextEncoder().encode(JSON.stringify(payload.custom_exercises)).length > 256 * 1024
      )
        throw new Error('空间自定义动作容量已满，请减少图片或清理动作。');
      await onSave(payload);
      guard.finish();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Dialog open title={exercise ? '编辑自定义动作' : '新建自定义动作'} onClose={guard.close}>
        <form className="fitness-form" onSubmit={save}>
          <Field label="动作名称">
            <input
              autoFocus
              value={draft.name}
              maxLength={200}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </Field>
          <div className="fitness-form-grid">
            <Field label="身体部位">
              <select
                value={draft.body_part}
                disabled={busy}
                onChange={(event) =>
                  setDraft({ ...draft, body_part: event.target.value as CustomExercise['body_part'] })
                }
              >
                {!draft.body_part && <option value="">请选择身体部位</option>}
                {parts.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name.zh}
                    {entry.is_deleted ? '（已删除）' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="训练器械">
              <select
                value={draft.equipment}
                disabled={busy}
                onChange={(event) =>
                  setDraft({ ...draft, equipment: event.target.value as CustomExercise['equipment'] })
                }
              >
                {!draft.equipment && <option value="">请选择训练器械</option>}
                {equipment.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name.zh}
                    {entry.is_deleted ? '（已删除）' : ''}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="图标">
            <select
              value={draft.icon}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, icon: event.target.value })}
            >
              {[
                ...new Set([draft.icon, 'dumbbell', 'activity', 'heart', 'flame', 'target', 'timer', 'footprints']),
              ].map((icon) => (
                <option value={icon} key={icon}>
                  {icon}
                </option>
              ))}
            </select>
          </Field>
          <Field label="动作图片">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={busy}
              onChange={(event) => void selectImage(event.target.files?.[0])}
            />
          </Field>
          {draft.image && (
            <div className="fitness-form">
              <img className="fitness-exercise-image" src={exerciseImage(draft.image)} alt="动作图片预览" />
              <Button variant="ghost" disabled={busy} onClick={() => setDraft({ ...draft, image: null })}>
                移除图片
              </Button>
            </div>
          )}
          {error !== null && <ErrorState error={error} />}
          <div className="fitness-dialog-actions">
            <Button type="submit" disabled={busy}>
              {busy ? '正在保存…' : '保存动作'}
            </Button>
          </div>
        </form>
      </Dialog>
      {guard.confirmation}
    </>
  );
}

/** 全局与动作级休息设置共享版本化偏好，音效能力依浏览器权限执行。 */
function PreferencesEditor({
  snapshot,
  catalog,
  exerciseId,
  exerciseName,
  onClose,
  onSave,
}: {
  snapshot?: FitnessPreferences;
  catalog?: Catalog;
  exerciseId?: string;
  exerciseName?: string;
  onClose: () => void;
  onSave: (payload: PreferencesPayload) => Promise<void>;
}) {
  const [initial] = useState(() => preferencesPayload(snapshot));
  const [draft, setDraft] = useState(initial);
  const initialSetting = exerciseId ? initial.exercise_rest_settings?.[exerciseId] : undefined;
  const [rest, setRest] = useState(String(initialSetting?.rest_seconds ?? initial.default_rest_seconds));
  const [warmup, setWarmup] = useState(
    String(initialSetting?.warmup_rest_seconds ?? initial.default_warmup_rest_seconds ?? initial.default_rest_seconds),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const guard = useDraftClose(
    JSON.stringify(draft) !== JSON.stringify(initial) ||
      rest !== String(initialSetting?.rest_seconds ?? initial.default_rest_seconds) ||
      warmup !==
        String(
          initialSetting?.warmup_rest_seconds ?? initial.default_warmup_rest_seconds ?? initial.default_rest_seconds,
        ),
    busy,
    onClose,
  );
  /** 秒数严格校验后修改对应层级，不覆盖其他动作的规则。 */
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (![rest, warmup].every((value) => /^\d+$/.test(value) && Number(value) <= 2147483647)) {
      setError(new Error('休息秒数请输入有效的非负整数。'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = structuredClone(draft);
      if (exerciseId)
        payload.exercise_rest_settings = {
          ...payload.exercise_rest_settings,
          [exerciseId]: { rest_seconds: Number(rest), warmup_rest_seconds: Number(warmup) },
        };
      else {
        payload.default_rest_seconds = Number(rest);
        payload.default_warmup_rest_seconds = Number(warmup);
      }
      await onSave(payload);
      guard.finish();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Dialog open onClose={guard.close} title={exerciseId ? `${exerciseName ?? '动作'}的设置` : '训练偏好'}>
        <form className="fitness-form" onSubmit={save}>
          <Field label="正式组休息（秒）" hint="0 表示不自动启动休息">
            <input inputMode="numeric" value={rest} disabled={busy} onChange={(event) => setRest(event.target.value)} />
          </Field>
          <Field label="热身组休息（秒）">
            <input
              inputMode="numeric"
              value={warmup}
              disabled={busy}
              onChange={(event) => setWarmup(event.target.value)}
            />
          </Field>
          {exerciseId ? (
            <label className="fitness-check">
              <input
                type="checkbox"
                disabled={busy}
                checked={draft.exercise_weight_modes[exerciseId] ?? usesSideWeight([], exerciseId, catalog, snapshot)}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    exercise_weight_modes: { ...draft.exercise_weight_modes, [exerciseId]: event.target.checked },
                  })
                }
              />
              默认分别记录左右重量
            </label>
          ) : (
            <>
              <label className="fitness-check">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={draft.sound_enabled}
                  onChange={(event) => setDraft({ ...draft, sound_enabled: event.target.checked })}
                />
                休息结束音效
              </label>
              <label className="fitness-check">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={draft.vibration_enabled}
                  onChange={(event) => setDraft({ ...draft, vibration_enabled: event.target.checked })}
                />
                休息结束振动（设备支持时）
              </label>
            </>
          )}
          {error !== null && <ErrorState error={error} />}
          <div className="fitness-dialog-actions">
            <Button type="submit" disabled={busy}>
              {busy ? '正在保存…' : '保存设置'}
            </Button>
          </div>
        </form>
      </Dialog>
      {guard.confirmation}
    </>
  );
}
