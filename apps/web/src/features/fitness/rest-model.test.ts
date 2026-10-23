import { describe, expect, it } from 'vitest';
import { newWorkout } from './fitness-model';
import { changeRest, completeSet, restElapsed, restRemaining, settleRest } from './rest-model';

/** 使用已填写有效次数的两个训练组验证跨组休息结算。 */
function fixture() {
  const draft = newWorkout('力量', '2026-10-01', undefined, '2026-10-01T00:00:00.000Z');
  draft.exercises = [
    {
      id: 'exercise',
      exercise_id: '0025',
      rest_seconds: 90,
      warmup_rest_seconds: 30,
      sets: [
        {
          id: 'set-a',
          kind: 'warmup',
          weight: '10',
          weight_left: null,
          weight_right: null,
          reps: 8,
          completed: false,
          rest_durations_seconds: [],
        },
        {
          id: 'set-b',
          kind: 'working',
          weight: '15',
          weight_left: null,
          weight_right: null,
          reps: 8,
          completed: false,
          rest_durations_seconds: [],
        },
      ],
    },
  ];
  return draft;
}
const now = Date.parse('2026-10-01T08:00:00.000Z');

describe('与手机一致的休息与组完成', () => {
  it('勾选有效组原子开始训练，热身采用热身时长', () => {
    const next = completeSet(fixture(), 'exercise', 'set-a', true, undefined, now);
    expect(next.status).toBe('in_progress');
    expect(next.run_segments).toEqual([{ started_at: new Date(now).toISOString(), ended_at: null }]);
    expect(next.rest_timer).toMatchObject({ duration_seconds: 30, set_id: 'set-a', exercise_id: 'exercise' });
    expect(next.exercises[0]!.sets[0]!.completed).toBe(true);
  });
  it('下一组先结算旧休息，最后一组仍然启动休息', () => {
    const first = completeSet(fixture(), 'exercise', 'set-a', true, undefined, now);
    const second = completeSet(first, 'exercise', 'set-b', true, undefined, now + 20000);
    expect(second.exercises[0]!.sets[0]!.rest_durations_seconds).toEqual([20]);
    expect(second.rest_timer).toMatchObject({ duration_seconds: 90, set_id: 'set-b' });
  });
  it('暂停不累计时间，延长目标不算已休息时间', () => {
    let draft = completeSet(fixture(), 'exercise', 'set-a', true, undefined, now);
    draft = changeRest(draft, 'pause', 0, now + 10000);
    expect(restRemaining(draft.rest_timer, now + 100000)).toBe(20);
    expect(restElapsed(draft.rest_timer!, now + 100000)).toBe(10);
    draft = changeRest(draft, 'adjust', 15, now + 100000);
    expect(draft.rest_timer?.remaining_seconds).toBe(35);
    draft = changeRest(draft, 'resume', 0, now + 100000);
    draft = changeRest(draft, 'finish', 0, now + 105000);
    expect(draft.exercises[0]!.sets[0]!.rest_durations_seconds).toEqual([15]);
  });
  it('到期后的等待不计入时长，结束后重复结算不会新增记录', () => {
    const first = completeSet(fixture(), 'exercise', 'set-a', true, undefined, now);
    const settled = settleRest(first, now + 300000);
    expect(settled.exercises[0]!.sets[0]!.rest_durations_seconds).toEqual([30]);
    expect(settleRest(settled, now + 900000)).toEqual(settled);
  });
  it('取消完成清空该组历史，但保留独立休息计时', () => {
    let draft = completeSet(fixture(), 'exercise', 'set-a', true, undefined, now);
    draft = changeRest(draft, 'start', 60, now + 10000);
    expect(draft.exercises[0]!.sets[0]!.rest_durations_seconds).toEqual([10]);
    draft = completeSet(draft, 'exercise', 'set-a', false, undefined, now + 11000);
    expect(draft.exercises[0]!.sets[0]!.rest_durations_seconds).toEqual([]);
    expect(draft.rest_timer).toMatchObject({ exercise_id: null, set_id: null, status: 'running' });
  });
  it('无有效次数不能启动训练，计时不因时钟回退变负', () => {
    const draft = fixture();
    draft.exercises[0]!.sets[0]!.reps = null;
    expect(() => completeSet(draft, 'exercise', 'set-a', true, undefined, now)).toThrow('有效次数');
    const running = completeSet(fixture(), 'exercise', 'set-a', true, undefined, now);
    expect(restElapsed(running.rest_timer!, now - 3000)).toBe(0);
  });
});
