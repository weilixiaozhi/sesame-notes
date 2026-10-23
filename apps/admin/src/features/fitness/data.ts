import { api, request } from '../../api/client';
import type { Paging } from '../../api/types';
import type { ExerciseContent, FitnessContent, FitnessKind, FitnessRow, PlanContent, TemplateContent } from './model';
import { editableContent } from './model';

/** 三种正文使用各自 SDK 契约，页面共用分页读取。 */
export async function listFitness(kind: FitnessKind, query: Paging & { q?: string }, signal?: AbortSignal) {
  const client =
    kind === 'exercise'
      ? api.adminFitnessExercises
      : kind === 'template'
        ? api.adminFitnessTemplates
        : api.adminFitnessPlans;
  return request<{ items: FitnessRow[]; total: number; page: number; page_size: number }>(
    () => client.list(query, signal),
    `fitness-${kind}-list`,
  );
}

/** 确认后的内容保存后立即生效，身份与修订始终从可编辑正文中移除。 */
export async function saveFitness(kind: FitnessKind, content: FitnessContent, enabled: boolean, current?: FitnessRow) {
  const editable = editableContent(content);
  if (kind === 'exercise') {
    const body = { content: editable as Omit<ExerciseContent, 'id'>, is_enabled: enabled };
    return request(
      () =>
        current
          ? api.adminFitnessExercises.update(current.id, { ...body, version: current.version })
          : api.adminFitnessExercises.create(body),
      'fitness-exercise-save',
    );
  }
  if (kind === 'template') {
    const body = { content: editable as Omit<TemplateContent, 'id' | 'revision'>, is_enabled: enabled };
    return request(
      () =>
        current
          ? api.adminFitnessTemplates.update(current.id, { ...body, version: current.version })
          : api.adminFitnessTemplates.create(body),
      'fitness-template-save',
    );
  }
  const body = { content: editable as Omit<PlanContent, 'id' | 'revision'>, is_enabled: enabled };
  return request(
    () =>
      current
        ? api.adminFitnessPlans.update(current.id, { ...body, version: current.version })
        : api.adminFitnessPlans.create(body),
    'fitness-plan-save',
  );
}
