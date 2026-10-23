import {
  AnyUuidSchema,
  NameSchema,
  CursorSchema,
  TimestampSchema,
  UuidSchema,
} from '../../shared/contracts/scalars.js';
import { Type, type Static } from '@sinclair/typebox';

export const DAY_MIN_DATE = '1901-01-01';
export const DAY_MAX_DATE = '2100-12-31';
export const DAY_MAX_INTERVAL = 36500;
export const DAY_DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';
export const DayDateSchema = Type.Object({
  calendar_type: Type.Union([Type.Literal('solar'), Type.Literal('lunar')]),
  original_year: Type.Integer({ minimum: 1900, maximum: 2100 }),
  original_month: Type.Integer({ minimum: 1, maximum: 12 }),
  original_day: Type.Integer({ minimum: 1, maximum: 31 }),
  is_leap_month: Type.Boolean(),
  solar_date: Type.String({ pattern: DAY_DATE_PATTERN }),
});
export const DayBookPayloadSchema = Type.Object({
  name: NameSchema,
  created_at: TimestampSchema,
});
export const DayEventPayloadSchema = Type.Object({
  name: NameSchema,
  category: Type.Union([
    Type.Literal('birthday'),
    Type.Literal('anniversary'),
    Type.Literal('countdown'),
    Type.Literal('stage'),
  ]),
  countdown_mode: Type.Union([Type.Literal('fixed_date'), Type.Literal('interval_days'), Type.Null()]),
  interval_days: Type.Union([Type.Integer({ minimum: 1, maximum: DAY_MAX_INTERVAL }), Type.Null()]),
  repeat_type: Type.Union([Type.Literal('none'), Type.Literal('yearly')]),
  statistic_type: Type.Union([Type.Literal('year'), Type.Literal('day')]),
  event: Type.Union([DayDateSchema, Type.Null()]),
  start: Type.Union([DayDateSchema, Type.Null()]),
  end: Type.Union([DayDateSchema, Type.Null()]),
  created_at: TimestampSchema,
});
const DayAuditSchema = {
  id: AnyUuidSchema,
  sync_id: UuidSchema,
  revision: Type.Integer({ minimum: 1 }),
  updated_at: TimestampSchema,
  deleted_at: Type.Union([TimestampSchema, Type.Null()]),
};
export const DayBookSchema = Type.Object({ ...DayBookPayloadSchema.properties, ...DayAuditSchema }, { $id: 'DayBook' });
export const DayEventSchema = Type.Object(
  { ...DayEventPayloadSchema.properties, ...DayAuditSchema, day_book_id: AnyUuidSchema },
  { $id: 'DayEvent' },
);
export const DayDeletePayloadSchema = Type.Object({
  expected_full_cursor: Type.Optional({
    ...CursorSchema,
    description: '删除日子本时需提供完整同步返回的 server_cursor，用于确认本内内容未变化。',
  }),
});

export type DayDate = Static<typeof DayDateSchema>;
export type DayEventDefinition = Static<typeof DayEventPayloadSchema>;
