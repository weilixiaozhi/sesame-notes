import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { WorkoutEditor } from './workout-editor';
import { newWorkout, type FitnessPreferences, type FitnessSpace, type Workout } from './fitness-model';
import { preferencesPayload } from './preferences-model';

const mocks = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('./weight-mode-save', () => ({ createWeightModeWriter: () => mocks.write }));
vi.mock('../../lib/session', () => ({ useSession: () => ({ session: { user: { user_id: 'owner' } } }) }));
vi.mock('../../lib/use-product-analytics', () => ({ useProductAnalyticsPage: vi.fn() }));
vi.mock('../../lib/product-analytics-runtime', () => ({
  captureProductAnalyticsContext: () => null,
  trackProductAction: vi.fn(),
}));
vi.mock('../../components/use-draft-close', () => ({
  useDraftClose: (_dirty: boolean, _busy: boolean, onClose: () => void) => ({ close: onClose, finish: onClose }),
}));

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
const preferences: FitnessPreferences = {
  ...preferencesPayload(),
  id: space.id,
  fitness_space_id: space.id,
  sync_id: space.sync_id,
  revision: 2,
  deleted_at: null,
  exercise_weight_modes: { '0025': true },
};

/** 使用重复动作实例验证整个动作的全部组同时更新，新增组继续使用动作口径。 */
function workout(): Workout {
  return {
    ...newWorkout('训练', '2026-10-19'),
    id: 'workout',
    fitness_space_id: space.id,
    sync_id: space.sync_id,
    revision: 1,
    deleted_at: null,
    exercises: ['first', 'second'].map((id) => ({
      id,
      exercise_id: '0025',
      rest_seconds: 90,
      warmup_rest_seconds: null,
      sets: [
        {
          id: `${id}-set`,
          kind: 'working',
          weight: '20',
          weight_left: null,
          weight_right: null,
          reps: 8,
          completed: false,
          rest_durations_seconds: [],
        },
      ],
    })),
  };
}

beforeEach(() => mocks.write.mockReset());

it('每个动作只有一个口径入口，保存偏好后所有实例和新增组统一显示', async () => {
  mocks.write.mockResolvedValue(preferences);
  const save = vi.fn().mockResolvedValue(undefined);
  render(<WorkoutEditor open space={space} workout={workout()} onClose={() => {}} onSave={save} />);
  expect(screen.getAllByRole('button', { name: /动作 \d 重量口径/ })).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: '动作 1 重量口径' }));
  await waitFor(() => expect(screen.getByLabelText('动作 2 第 1 组左侧重量')).toBeTruthy());
  expect(mocks.write).toHaveBeenCalledWith('0025', true);
  expect((screen.getByLabelText('动作 1 第 1 组左侧重量') as HTMLInputElement).value).toBe('20');
  expect((screen.getByLabelText('动作 2 第 1 组右侧重量') as HTMLInputElement).value).toBe('20');
  fireEvent.click(screen.getAllByRole('button', { name: '添加一组' })[0]!);
  expect((screen.getByLabelText('动作 1 第 2 组左侧重量') as HTMLInputElement).value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: '保存训练' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0]![0].exercises[0].sets[0]).toMatchObject({
    weight: null,
    weight_left: '20',
    weight_right: '20',
  });
});

it('偏好保存失败保留总重量和草稿，成功重试后才切换', async () => {
  mocks.write.mockRejectedValueOnce(new Error('保存失败，请重试')).mockResolvedValueOnce(preferences);
  render(<WorkoutEditor open space={space} workout={workout()} onClose={() => {}} onSave={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '动作 1 重量口径' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect((screen.getByLabelText('动作 1 第 1 组重量') as HTMLInputElement).value).toBe('20');
  expect(screen.queryByLabelText('动作 1 第 1 组左侧重量')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '动作 1 重量口径' }));
  await waitFor(() => expect(screen.getByLabelText('动作 1 第 1 组左侧重量')).toBeTruthy());
});

it('其他训练改变偏好后，历史成绩与同动作空白实例仍按记录口径编辑保存', async () => {
  const previous = workout();
  previous.exercises.push({
    ...previous.exercises[0]!,
    id: 'blank-instance',
    sets: [{ ...previous.exercises[0]!.sets[0]!, id: 'blank-set', weight: null }],
  });
  const save = vi.fn().mockResolvedValue(undefined);
  render(
    <WorkoutEditor open space={space} workout={previous} preferences={preferences} onClose={() => {}} onSave={save} />,
  );
  expect((screen.getByLabelText('动作 1 第 1 组重量') as HTMLInputElement).value).toBe('20');
  expect((screen.getByLabelText('动作 3 第 1 组重量') as HTMLInputElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('动作 1 第 1 组重量'), { target: { value: '22' } });
  fireEvent.click(screen.getByRole('button', { name: '保存训练' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0]![0].exercises[0].sets[0]).toMatchObject({
    weight: '22',
    weight_left: null,
    weight_right: null,
  });
  expect(save.mock.calls[0]![0].exercises[1].sets[0].weight).toBe('20');
});

it('清空最后一个重量保持输入口径，明确切换失败保留原样，成功回执后才换输入框', async () => {
  const previous = workout();
  previous.exercises = previous.exercises.slice(0, 1);
  mocks.write.mockRejectedValueOnce(new Error('保存失败，请重试')).mockResolvedValueOnce(preferences);
  render(
    <WorkoutEditor
      open
      space={space}
      workout={previous}
      preferences={preferences}
      onClose={() => {}}
      onSave={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText('动作 1 第 1 组重量'), { target: { value: '' } });
  expect((screen.getByLabelText('动作 1 第 1 组重量') as HTMLInputElement).value).toBe('');
  expect(screen.queryByLabelText('动作 1 第 1 组左侧重量')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '动作 1 重量口径' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(screen.getByLabelText('动作 1 第 1 组重量')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '动作 1 重量口径' }));
  await waitFor(() => expect(screen.getByLabelText('动作 1 第 1 组左侧重量')).toBeTruthy());
  expect(mocks.write).toHaveBeenNthCalledWith(1, '0025', true);
  expect(mocks.write).toHaveBeenNthCalledWith(2, '0025', true);
});

it('空白动作尚未开始输入时采用异步加载的偏好', () => {
  const previous = workout();
  previous.exercises[0]!.sets[0]!.weight = null;
  previous.exercises[1]!.sets[0]!.weight = null;
  const props = { open: true, space, workout: previous, onClose: () => {}, onSave: vi.fn() };
  const { rerender } = render(<WorkoutEditor {...props} />);
  expect(screen.getByLabelText('动作 1 第 1 组重量')).toBeTruthy();
  rerender(<WorkoutEditor {...props} preferences={preferences} />);
  expect(screen.getByLabelText('动作 1 第 1 组左侧重量')).toBeTruthy();
  expect(screen.getByLabelText('动作 2 第 1 组左侧重量')).toBeTruthy();
});
