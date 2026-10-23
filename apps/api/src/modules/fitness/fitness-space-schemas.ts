import { Type } from '@sinclair/typebox';
import { privateBookPayloadFields } from '../private-books/index.js';
import { AnyUuidSchema, TimestampSchema, UuidSchema } from '../../shared/contracts/scalars.js';

// 空间与其他私有本共用名称、内容时间和条件恢复载荷。
export const FitnessSpacePayloadSchema = Type.Object(privateBookPayloadFields);
export const FitnessSpaceSchema = Type.Object({
  ...FitnessSpacePayloadSchema.properties,
  id: AnyUuidSchema,
  sync_id: UuidSchema,
  revision: Type.Integer({ minimum: 1 }),
  deleted_at: Type.Union([TimestampSchema, Type.Null()]),
});
