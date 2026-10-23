import { Type, type Static } from '@sinclair/typebox';
import { CategorySchema, TransactionTypeSchema } from './accounting.js';
import { AnyUuidSchema, NameSchema, TimestampSchema } from './scalars.js';

export const CategoryVersionTokenSchema = Type.String({ pattern: '^[a-f0-9]{64}$' });
const CategoryDraftSchema = Type.Object(
  {
    name: NameSchema,
    kind: TransactionTypeSchema,
    level: Type.Union([Type.Literal(1), Type.Literal(2)]),
    sort_order: Type.Integer({ minimum: -2147483648, maximum: 2147483647 }),
    icon: Type.Union([Type.String({ maxLength: 255 }), Type.Null()]),
    parent_id: Type.Union([AnyUuidSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type CategoryDraft = Static<typeof CategoryDraftSchema>;
export const CategoryResolutionSchema = Type.Object(
  {
    conflict_id: AnyUuidSchema,
    candidate_version: Type.Integer({ minimum: 1 }),
    source_device_id: AnyUuidSchema,
    source_mutation_id: AnyUuidSchema,
    resolution: Type.Union([Type.Literal('cloud'), Type.Literal('local')]),
    category_state: Type.Ref(CategorySchema),
  },
  { $id: 'CategoryResolution' },
);
export const CategoryConflictSchema = Type.Object(
  {
    id: AnyUuidSchema,
    category_id: AnyUuidSchema,
    template_key: Type.String(),
    source_device_id: AnyUuidSchema,
    source_mutation_id: AnyUuidSchema,
    candidate_version: Type.Integer({ minimum: 1 }),
    action: Type.Union([Type.Literal('upsert'), Type.Literal('delete')]),
    local_payload: Type.Union([CategoryDraftSchema, Type.Null()]),
    local_updated_at: TimestampSchema,
    cloud_snapshot: Type.Ref(CategorySchema),
    status: Type.Union([Type.Literal('pending'), Type.Literal('resolved')]),
    resolution: Type.Union([Type.Literal('cloud'), Type.Literal('local'), Type.Null()]),
    created_at: TimestampSchema,
    resolved_at: Type.Union([TimestampSchema, Type.Null()]),
  },
  { $id: 'CategoryConflict' },
);
