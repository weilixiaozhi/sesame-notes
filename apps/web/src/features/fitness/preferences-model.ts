import type { paths } from '@sesame-notes/api-client';
import type { FitnessPreferences } from './fitness-model';
type Change = paths['/api/v1/sync/push']['post']['requestBody']['content']['application/json']['changes'][number];
export type PreferencesPayload = Extract<Change, { entity_type: 'fitness_preferences'; action: 'upsert' }>['payload'];
export type CustomExercise = PreferencesPayload['custom_exercises'][number];
export const bodyPartLabels: Record<CustomExercise['body_part'], string> = {
  back: '背部',
  cardio: '有氧',
  chest: '胸部',
  'lower arms': '前臂',
  'lower legs': '小腿',
  neck: '颈部',
  shoulders: '肩部',
  'upper arms': '上臂',
  'upper legs': '大腿',
  waist: '腰腹',
};
export const equipmentLabels: Record<CustomExercise['equipment'], string> = {
  assisted: '辅助器械',
  band: '弹力带',
  barbell: '杠铃',
  'body weight': '自重',
  'bosu ball': '波速球',
  cable: '绳索器械',
  dumbbell: '哑铃',
  'elliptical machine': '椭圆机',
  'ez barbell': '曲杆杠铃',
  hammer: '训练锤',
  kettlebell: '壶铃',
  'leverage machine': '杠杆器械',
  'medicine ball': '药球',
  'olympic barbell': '奥林匹克杠铃',
  'resistance band': '阻力带',
  roller: '滚轮',
  rope: '绳索',
  'skierg machine': '滑雪机',
  'sled machine': '雪橇机',
  'smith machine': '史密斯机',
  'stability ball': '健身球',
  'stationary bike': '固定自行车',
  'stepmill machine': '登阶机',
  tire: '轮胎',
  'trap bar': '六角杠铃',
  'upper body ergometer': '上肢功率车',
  weighted: '负重',
  'wheel roller': '健腹轮',
};
/** 默认偏好与手机一致，已有快照只去掉传输元数据，保留所有用户设置。 */
export function preferencesPayload(snapshot?: FitnessPreferences, now = new Date().toISOString()): PreferencesPayload {
  return snapshot
    ? {
        custom_exercises: structuredClone(snapshot.custom_exercises),
        default_rest_seconds: snapshot.default_rest_seconds,
        ...(snapshot.default_warmup_rest_seconds !== undefined
          ? { default_warmup_rest_seconds: snapshot.default_warmup_rest_seconds }
          : {}),
        ...(snapshot.exercise_rest_settings
          ? { exercise_rest_settings: structuredClone(snapshot.exercise_rest_settings) }
          : {}),
        sound_enabled: snapshot.sound_enabled,
        vibration_enabled: snapshot.vibration_enabled,
        pinned_exercise_ids: [...snapshot.pinned_exercise_ids],
        exercise_weight_modes: { ...snapshot.exercise_weight_modes },
        created_at: snapshot.created_at,
        updated_at: now,
      }
    : {
        custom_exercises: [],
        default_rest_seconds: 90,
        sound_enabled: true,
        vibration_enabled: true,
        pinned_exercise_ids: [],
        exercise_weight_modes: {},
        created_at: now,
        updated_at: now,
      };
}
/** 自定义动作删除只隐藏定义，历史动作名称仍可解析；去除不再适用的置顶与休息设置。 */
export function deleteCustomExercise(payload: PreferencesPayload, id: string): PreferencesPayload {
  const next = structuredClone(payload);
  next.custom_exercises = next.custom_exercises.map((exercise) =>
    exercise.id === id ? { ...exercise, deleted: true, image: null } : exercise,
  );
  next.pinned_exercise_ids = next.pinned_exercise_ids.filter((entry) => entry !== id);
  if (next.exercise_rest_settings) delete next.exercise_rest_settings[id];
  return next;
}
/** 图片载荷保持手机的 base64 二进制格式，展示时按文件头确定安全图片类型。 */
export function exerciseImage(value: string | null): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('/9j/')) return `data:image/jpeg;base64,${value}`;
  if (value.startsWith('iVBOR')) return `data:image/png;base64,${value}`;
  if (value.startsWith('R0lG')) return `data:image/gif;base64,${value}`;
  if (value.startsWith('UklG')) return `data:image/webp;base64,${value}`;
  return undefined;
}
