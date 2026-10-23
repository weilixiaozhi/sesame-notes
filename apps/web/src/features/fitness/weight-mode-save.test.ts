import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '@sesame-notes/api-client';
import { createWeightModeWriter } from './weight-mode-save';
import { preferencesPayload } from './preferences-model';
import type { FitnessPreferences, FitnessSpace } from './fitness-model';

const mocks = vi.hoisted(() => ({ get: vi.fn(), push: vi.fn() }));
vi.mock('../../lib/session', () => ({ api: { GET: mocks.get }, pushChange: mocks.push }));
const space: FitnessSpace = {
  id: 'space',
  sync_id: 'sync',
  name: '健身',
  updated_at: '2026-10-19T00:00:00.000Z',
  created_at: '2026-10-19T00:00:00.000Z',
  revision: 1,
  deleted_at: null,
  entity_count: 1,
};
const before: FitnessPreferences = {
  ...preferencesPayload(),
  id: space.id,
  fitness_space_id: space.id,
  sync_id: space.sync_id,
  revision: 2,
  deleted_at: null,
  exercise_weight_modes: { '0001': false },
};
const after: FitnessPreferences = { ...before, revision: 3, exercise_weight_modes: { '0001': false, '0025': true } };

beforeEach(() => {
  mocks.get.mockReset();
  mocks.push.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

it('结果未知重试复用请求身份，确认偏好后返回最新版本', async () => {
  mocks.get.mockResolvedValueOnce({ data: { items: [before] } }).mockResolvedValueOnce({ data: { items: [after] } });
  mocks.push.mockRejectedValueOnce(new Error('网络中断')).mockResolvedValueOnce(undefined);
  const write = createWeightModeWriter(space);
  await expect(write('0025', true)).rejects.toThrow('网络中断');
  await expect(write('0025', true)).resolves.toEqual(after);
  expect(mocks.push.mock.calls[0]![0]).toBe(mocks.push.mock.calls[1]![0]);
  expect(mocks.push.mock.calls[0]![0]).toMatchObject({
    base_revision: 2,
    payload: { exercise_weight_modes: { '0001': false, '0025': true } },
  });
});

it('版本冲突重试读取最新偏好，不覆盖其他动作的新设置', async () => {
  const changed = { ...before, revision: 3, exercise_weight_modes: { '0001': true } };
  mocks.get
    .mockResolvedValueOnce({ data: { items: [before] } })
    .mockResolvedValueOnce({ data: { items: [changed] } })
    .mockResolvedValueOnce({ data: { items: [after] } });
  mocks.push
    .mockRejectedValueOnce(new ApiError(409, 'SYNC_WRITE_FAILED', '设置已变化'))
    .mockResolvedValueOnce(undefined);
  const write = createWeightModeWriter(space);
  await expect(write('0025', true)).rejects.toThrow('设置已变化');
  await expect(write('0025', true)).resolves.toEqual(after);
  expect(mocks.push.mock.calls[1]![0]).toMatchObject({
    base_revision: 3,
    payload: { exercise_weight_modes: { '0001': true, '0025': true } },
  });
  expect(mocks.push.mock.calls[0]![0].mutation_id).not.toBe(mocks.push.mock.calls[1]![0].mutation_id);
});

it('上次请求结果未知时切换另一动作，使用新动作自己的请求身份', async () => {
  const other = { ...before, revision: 3, exercise_weight_modes: { '0001': true } };
  mocks.get
    .mockResolvedValueOnce({ data: { items: [before] } })
    .mockResolvedValueOnce({ data: { items: [before] } })
    .mockResolvedValueOnce({ data: { items: [other] } });
  mocks.push.mockRejectedValueOnce(new Error('网络中断')).mockResolvedValueOnce(undefined);
  const write = createWeightModeWriter(space);
  await expect(write('0025', true)).rejects.toThrow('网络中断');
  await expect(write('0001', true)).resolves.toEqual(other);
  expect(mocks.push.mock.calls[1]![0].payload.exercise_weight_modes).toEqual({ '0001': true });
  expect(mocks.push.mock.calls[0]![0].mutation_id).not.toBe(mocks.push.mock.calls[1]![0].mutation_id);
});
