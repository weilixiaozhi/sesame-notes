import { describe, expect, it } from 'vitest';
import { deleteCustomExercise, exerciseImage, preferencesPayload } from './preferences-model';
describe('健身空间偏好保真', () => {
  it('删除自定义动作只隐藏，历史定义与其他设置保留', () => {
    const payload = preferencesPayload();
    payload.custom_exercises = [
      {
        id: 'custom:old',
        name: '旧动作',
        body_part: 'chest',
        equipment: 'dumbbell',
        icon: 'dumbbell',
        image: 'image',
        deleted: false,
      },
    ];
    payload.pinned_exercise_ids = ['custom:old', '0025'];
    payload.exercise_rest_settings = {
      'custom:old': { rest_seconds: 90, warmup_rest_seconds: 30 },
      '0025': { rest_seconds: 60, warmup_rest_seconds: 20 },
    };
    const next = deleteCustomExercise(payload, 'custom:old');
    expect(next.custom_exercises[0]).toMatchObject({ name: '旧动作', deleted: true, image: null });
    expect(next.pinned_exercise_ids).toEqual(['0025']);
    expect(next.exercise_rest_settings).toEqual({ '0025': { rest_seconds: 60, warmup_rest_seconds: 20 } });
    expect(payload.custom_exercises[0]?.deleted).toBe(false);
  });
  it('默认休息与提示偏好和手机客户端相同', () => {
    expect(preferencesPayload()).toMatchObject({
      default_rest_seconds: 90,
      sound_enabled: true,
      vibration_enabled: true,
      custom_exercises: [],
      pinned_exercise_ids: [],
      exercise_weight_modes: {},
    });
  });
  it('只展示可识别的图片格式，不构造任意数据媒体', () => {
    expect(exerciseImage('/9j/test')).toBe('data:image/jpeg;base64,/9j/test');
    expect(exerciseImage('PHN2ZyBvbmxvYWQ9')).toBeUndefined();
  });
});
