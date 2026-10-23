import { Type, type TSchema } from '@sinclair/typebox';
import { UuidSchema } from '../../shared/contracts/scalars.js';

export const AdminIdentityTypeSchema = Type.Union([Type.Literal('super_admin'), Type.Literal('standard_user')]);
const AdminGroupSummarySchema = Type.Object({
  id: UuidSchema,
  name: Type.String(),
  is_enabled: Type.Boolean(),
  is_default: Type.Boolean(),
  version: Type.Integer(),
});
const AdminIdentitySchema = Type.Object({
  id: UuidSchema,
  username: Type.String(),
  email: Type.Union([Type.String(), Type.Null()]),
  phone: Type.Union([Type.String(), Type.Null()]),
  display_name: Type.String(),
  identity_type: AdminIdentityTypeSchema,
  group_id: UuidSchema,
  group: AdminGroupSummarySchema,
  is_enabled: Type.Boolean(),
  permissions: Type.Array(Type.String()),
  allowed_pages: Type.Array(Type.String()),
  authorization_version: Type.String(),
});
export const AdminSessionSchema = Type.Object({
  admin: AdminIdentitySchema,
  expires_at: Type.String({ format: 'date-time' }),
});
const NullableText = Type.Union([Type.String(), Type.Null()]);
const SourceFields = {
  created_by: NullableText,
  updated_by: NullableText,
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
};
export const AdminAccountSchema = Type.Object({
  id: UuidSchema,
  username: Type.String(),
  email: NullableText,
  phone: NullableText,
  display_name: Type.String(),
  identity_type: AdminIdentityTypeSchema,
  group_id: UuidSchema,
  group: AdminGroupSummarySchema,
  is_enabled: Type.Boolean(),
  version: Type.Integer(),
  last_login_at: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  ...SourceFields,
});
export const AdminGroupSchema = Type.Object({
  id: UuidSchema,
  is_default: Type.Boolean(),
  name: Type.String(),
  description: Type.String(),
  sort: Type.Integer(),
  is_enabled: Type.Boolean(),
  permissions: Type.Array(Type.String()),
  page_ids: Type.Array(Type.String()),
  version: Type.Integer(),
  member_count: Type.Integer(),
  ...SourceFields,
});
export const AdminPageQueryProperties = {
  page: Type.Optional(Type.Integer({ minimum: 1 })),
  page_size: Type.Optional(Type.Union([Type.Literal(10), Type.Literal(20), Type.Literal(50), Type.Literal(100)])),
};
export { AdminReasonSchema } from './admin-pagination.js';
export const AdminVersionSchema = Type.Integer({ minimum: 1 });

/** 所有总数列表使用相同的分页响应。 */
function adminPagedSchema(item: TSchema) {
  return Type.Object({
    items: Type.Array(item),
    page: Type.Integer(),
    page_size: Type.Integer(),
    total: Type.Integer(),
  });
}
export const AdminAccountListSchema = adminPagedSchema(AdminAccountSchema);
export const AdminGroupListSchema = adminPagedSchema(AdminGroupSchema);
