import type { paths } from '@sesame-notes/api-client';

type Snapshot = paths['/api/v1/sync/fitness-spaces/full']['get']['responses'][200]['content']['application/json'];
export type FitnessSpace =
  paths['/api/v1/sync/fitness-spaces']['get']['responses'][200]['content']['application/json']['fitness_spaces'][number];
export type Workout = Snapshot['fitness_workouts'][number];
export type FitnessTemplate = Snapshot['fitness_templates'][number];
export type FitnessPlan = Snapshot['fitness_plans'][number];
export type FitnessPreferences = Snapshot['fitness_preferences'][number];
type Changes = paths['/api/v1/sync/push']['post']['requestBody']['content']['application/json']['changes'][number];
type WorkoutChange = Extract<Changes, { entity_type: 'fitness_workout'; action: 'upsert' }>;
export type WorkoutPayload = WorkoutChange['payload'];
type TemplateChange = Extract<Changes, { entity_type: 'fitness_template'; action: 'upsert' }>;
export type TemplatePayload = TemplateChange['payload'];
export type WorkoutExercise = WorkoutPayload['exercises'][number];
export type WorkoutSet = WorkoutExercise['sets'][number];
export type Library = paths['/api/v1/fitness/library']['get']['responses'][200]['content']['application/json'];
export type OfficialTemplate = Library['templates'][number];
export type Catalog = {
  taxonomies?: {
    body_parts: FitnessTaxon[];
    equipment: FitnessTaxon[];
  };
  exercises: Array<
    Omit<(typeof import('./exercise-catalog.json'))['exercises'][number], 'attribution'> & {
      media_url?: string;
      is_enabled?: boolean;
      instructions_zh_hant?: string[];
      instructions_en?: string[];
    }
  >;
  content_version?: number;
};

export type FitnessTaxon = {
  id: string;
  name: { zh: string; zh_hant: string; en: string };
  is_deleted: boolean;
};
