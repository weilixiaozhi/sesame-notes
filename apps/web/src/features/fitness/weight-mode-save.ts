import { ApiError, unwrap } from '@sesame-notes/api-client';
import { api, pushChange, type SyncChange } from '../../lib/session';
import type { FitnessPreferences, FitnessSpace } from './fitness-model';
import { preferencesPayload } from './preferences-model';

/** 固定空间身份并冻结结果未知的请求；回执确认成功后才允许编辑器转换当前草稿。 */
export function createWeightModeWriter(space: FitnessSpace) {
  let attempt: Extract<SyncChange, { entity_type: 'fitness_preferences'; action: 'upsert' }> | null = null;
  let intent = '';

  /** 每次新操作读取当前偏好版本，保留其他动作及空间设置；失败重试沿用原请求身份。 */
  return async (exerciseId: string, side: boolean): Promise<FitnessPreferences> => {
    try {
      const nextIntent = `${exerciseId}:${side}`;
      if (intent !== nextIntent) {
        attempt = null;
        intent = nextIntent;
      }
      if (!attempt) {
        const current = unwrap(
          await api.GET('/api/v1/fitness-spaces/{fitness_space_id}/preferences', {
            params: { path: { fitness_space_id: space.id }, query: { limit: 1 } },
          }),
        ).items[0];
        const payload = preferencesPayload(current);
        payload.exercise_weight_modes[exerciseId] = side;
        attempt = {
          mutation_id: crypto.randomUUID(),
          entity_type: 'fitness_preferences',
          entity_id: space.id,
          ledger_id: null,
          day_book_id: null,
          memo_book_id: null,
          fitness_space_id: space.id,
          sync_id: space.sync_id,
          base_revision: current?.revision ?? 0,
          action: 'upsert',
          updated_at: payload.updated_at,
          payload,
        };
      }
      await pushChange(attempt);
      const confirmed = unwrap(
        await api.GET('/api/v1/fitness-spaces/{fitness_space_id}/preferences', {
          params: { path: { fitness_space_id: space.id }, query: { limit: 1 } },
        }),
      ).items[0];
      if (!confirmed || confirmed.exercise_weight_modes[exerciseId] !== side) {
        attempt = null;
        throw new Error('动作重量设置已变化，请重新选择重量口径。');
      }
      attempt = null;
      return confirmed;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) attempt = null;
      console.error('保存动作重量口径失败，保留当前训练草稿', error);
      throw error;
    }
  };
}
