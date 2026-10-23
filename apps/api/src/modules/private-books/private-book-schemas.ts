import { NameSchema, TimestampSchema, CursorSchema } from '../../shared/contracts/scalars.js';
import { Type } from '@sinclair/typebox';

export const privateBookPayloadFields = {
  name: NameSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  restore: Type.Optional(Type.Boolean()),
  expected_full_cursor: Type.Optional(CursorSchema),
};
