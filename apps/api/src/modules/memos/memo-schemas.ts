import { privateBookPayloadFields } from '../private-books/index.js';
import { Type, type Static } from '@sinclair/typebox';
import { AnyUuidSchema, TimestampSchema, UuidSchema } from '../../shared/contracts/scalars.js';

const MemoTypeSchema = Type.Union(['normal', 'credentials'].map((value) => Type.Literal(value)));
// 正文形状由 body_format 区分（delta_v1 / fields_v1），具体规则由 memo-rules 语义校验；
// 契约里用自由对象表达，避免生成端把 anyOf 的对象分支合并成两个分支同时存在。
const memoBodySchema = Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]);
export const MemoBookPayloadSchema = Type.Object({ ...privateBookPayloadFields, type: MemoTypeSchema });
export const MemoEntryPayloadSchema = Type.Object({
  book_type: MemoTypeSchema,
  title: Type.String(),
  // 正文按格式互斥：普通笔记是 delta_v1，账号密码卡片是 fields_v1。
  body_format: Type.Union([Type.Literal('delta_v1'), Type.Literal('fields_v1'), Type.Null()]),
  body: memoBodySchema,
  order_key: Type.Union([Type.String({ pattern: '^(0|[1-9][0-9]*)$' }), Type.Null()]),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});
const audit = {
  id: AnyUuidSchema,
  sync_id: UuidSchema,
  revision: Type.Integer({ minimum: 1 }),
  deleted_at: Type.Union([TimestampSchema, Type.Null()]),
};
export const MemoBookSchema = Type.Object({ ...MemoBookPayloadSchema.properties, ...audit }, { $id: 'MemoBook' });
export const MemoEntrySchema = Type.Object(
  { ...MemoEntryPayloadSchema.properties, ...audit, memo_book_id: AnyUuidSchema, book_updated_at: TimestampSchema },
  { $id: 'MemoEntry' },
);
export type MemoEntryPayload = Static<typeof MemoEntryPayloadSchema>;
