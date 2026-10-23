import { Type } from '@sinclair/typebox';

import { AnyUuidSchema } from '../../shared/contracts/scalars.js';

const NullableText = Type.Union([Type.String(), Type.Null()]);
const NullableTime = Type.Union([Type.String({ format: 'date-time' }), Type.Null()]);

const AdminUserSchema = Type.Object({
  id: AnyUuidSchema,
  phone: Type.String(),
  phone_masked: NullableText,
  sesame_number: NullableText,
  display_name: NullableText,
  gender: Type.Union([Type.Literal('UNSPECIFIED'), Type.Literal('MALE'), Type.Literal('FEMALE')]),
  avatar_url: NullableText,
  avatar_version: Type.Integer({ minimum: 0 }),
  is_enabled: Type.Boolean(),
  created_at: Type.String({ format: 'date-time' }),
});

export const AdminUserDetailSchema = Type.Composite([
  AdminUserSchema,
  Type.Object({
    profile_updated_at: NullableTime,
    primary_currency: NullableText,
    theme_primary_color: NullableText,
  }),
]);

export const AdminUserListSchema = Type.Object({
  items: Type.Array(AdminUserSchema),
  page: Type.Integer({ minimum: 1 }),
  page_size: Type.Integer({ minimum: 1 }),
  total: Type.Integer({ minimum: 0 }),
});

export const AdminUserStateSchema = Type.Object({
  id: AnyUuidSchema,
  phone_masked: NullableText,
  is_enabled: Type.Boolean(),
});

const AdminDeviceSchema = Type.Object({
  id: AnyUuidSchema,
  name: Type.String(),
  platform: Type.String(),
  app_version: NullableText,
  os_version: NullableText,
  device_model: NullableText,
  last_ip: NullableText,
  created_at: Type.String({ format: 'date-time' }),
  last_seen_at: Type.String({ format: 'date-time' }),
  revoked_at: NullableTime,
});

export const AdminDeviceListSchema = Type.Object({
  items: Type.Array(AdminDeviceSchema),
  page: Type.Integer({ minimum: 1 }),
  page_size: Type.Integer({ minimum: 1 }),
  total: Type.Integer({ minimum: 0 }),
});
