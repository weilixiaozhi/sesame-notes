import { z } from 'zod';
import type { ResponseValidator } from '@sesame-notes/api-client';
import { analyticsCatalogSchema, analyticsDetailsSchema, analyticsFunnelSchema } from './analytics-contracts';

const text = z.string();
const nullable = text.nullable();
const version = z.number().int().min(1);
const groupSummary = z.object({ id: text, name: text, is_enabled: z.boolean(), is_default: z.boolean(), version });
const identity = z.enum(['super_admin', 'standard_user']);
const source = { created_by: nullable, updated_by: nullable, created_at: text, updated_at: text };
const account = z.object({
  id: text,
  username: text,
  email: nullable,
  phone: nullable,
  display_name: text,
  identity_type: identity,
  group_id: text,
  group: groupSummary,
  is_enabled: z.boolean(),
  version,
  last_login_at: nullable,
  ...source,
});
const group = z.object({
  id: text,
  name: text,
  description: text,
  sort: z.number().int(),
  is_enabled: z.boolean(),
  is_default: z.boolean(),
  permissions: z.array(text),
  page_ids: z.array(text),
  version,
  member_count: z.number().int().nonnegative(),
  ...source,
});
const user = z.object({
  id: text,
  phone: text,
  sesame_number: nullable,
  display_name: nullable,
  gender: z.enum(['UNSPECIFIED', 'MALE', 'FEMALE']),
  is_enabled: z.boolean(),
  created_at: text,
  avatar_url: nullable,
  avatar_version: z.number().int().nonnegative(),
});
const userDetail = user.extend({
  profile_updated_at: nullable,
  primary_currency: nullable,
  theme_primary_color: nullable,
});
const device = z.object({
  id: text,
  name: text,
  platform: text,
  app_version: nullable,
  os_version: nullable,
  device_model: nullable,
  last_ip: nullable,
  created_at: text,
  last_seen_at: text,
  revoked_at: nullable,
});
const audit = z.object({
  id: text,
  action_label: text,
  actor_display: nullable,
  target_display: nullable,
  summary: nullable,
  reason: nullable,
  created_at: text,
  ip: nullable,
});
const identityOption = z.object({ value: text, label: text });
const catalog = z.object({
  permissions: z.array(z.object({ id: text, label: text, dependencies: z.array(text) })),
  pages: z.array(
    z.object({ id: text, label: text, path: text, required_permissions: z.array(text), assignable: z.boolean() }),
  ),
  identities: z.array(identityOption),
});
const session = z.object({
  admin: z.object({
    id: text,
    username: text,
    email: nullable,
    phone: nullable,
    display_name: text,
    identity_type: identity,
    group_id: text,
    group: groupSummary,
    is_enabled: z.boolean(),
    permissions: z.array(text),
    allowed_pages: z.array(text),
    authorization_version: text,
  }),
  expires_at: text,
});
const metrics = z.object({
  new_users: z.number().int().nonnegative(),
  active_users: z.number().int().nonnegative(),
  page_views: z.number().int().nonnegative(),
});
const analyticsReport = z.object({
  range: z.object({
    start_date: text,
    end_date: text,
    timezone: z.literal('Asia/Shanghai'),
    bucket: z.enum(['hour', 'day', 'month']),
    platform: z.enum(['all', 'app', 'web']),
  }),
  summary: metrics,
  series: z.array(metrics.extend({ period_start: z.iso.datetime() })),
  coverage: z.object({
    collection_started_at: z.iso.datetime(),
    complete: z.boolean(),
  }),
});
const officialContent = z.object({ id: text }).passthrough();
const officialRow = z.object({
  id: text,
  kind: z.enum(['exercise', 'template', 'plan']),
  version,
  content: officialContent,
  is_enabled: z.boolean(),
  created_at: text,
  updated_at: text,
  updated_by: nullable,
});
const fitnessTaxonomy = z.object({
  id: text,
  kind: z.enum(['body_part', 'equipment']),
  name: z.object({ zh: text.min(1), zh_hant: text.min(1), en: text.min(1) }),
  sort_order: z.number().int().min(0).max(9999),
  version,
  is_deleted: z.boolean(),
  exercise_count: z.number().int().nonnegative(),
  template_count: z.number().int().nonnegative(),
});

/** 运行时校验只用于拒绝不完整响应，接口类型仍由生成契约推导。 */
function paged(item: z.ZodType) {
  return z.object({
    items: z.array(item),
    page: z.number().int().positive(),
    page_size: z.union([z.literal(10), z.literal(20), z.literal(50), z.literal(100)]),
    total: z.number().int().nonnegative(),
  });
}

/** 每个读取接口检查本页面真正使用的白名单字段，失败由共享客户端转换成友好协议错误。 */
export const validateAdminResponse: ResponseValidator = ({ method, path, body }) => {
  if (path === '/api/v1/admin/analytics/funnel' && method === 'POST') {
    analyticsFunnelSchema.parse(body);
    return;
  }
  if (path === '/api/v1/admin/analytics/details' && method === 'GET') {
    analyticsDetailsSchema.parse(body);
    return;
  }
  if (path === '/api/v1/admin/analytics/catalog' && method === 'GET') {
    analyticsCatalogSchema.parse(body);
    return;
  }
  if (path === '/api/v1/admin/auth/me' || path === '/api/v1/admin/auth/login') {
    session.parse(body);
    return;
  }
  if (method === 'PUT' && path === '/api/v1/admin/users/{user_id}/avatar') {
    z.object({ avatar_url: text, avatar_version: version }).parse(body);
    return;
  }
  if (path === '/api/v1/admin/fitness/taxonomies/{kind}') {
    if (method === 'GET') z.object({ items: z.array(fitnessTaxonomy) }).parse(body);
    if (method === 'POST') fitnessTaxonomy.parse(body);
    return;
  }
  if (method === 'PATCH' && path === '/api/v1/admin/fitness/taxonomies/{kind}/{taxon_id}') {
    fitnessTaxonomy.parse(body);
    return;
  }
  if (method !== 'GET') return;
  if (path === '/api/v1/admin/analytics') {
    analyticsReport.parse(body);
    return;
  }
  if (/^\/api\/v1\/admin\/fitness\/(?:exercises|templates|plans)$/.test(path)) {
    paged(officialRow).parse(body);
    return;
  }
  if (path === '/api/v1/admin/fitness/references') {
    const items = z.array(z.object({ id: text, name: text, is_enabled: z.boolean() }));
    z.object({ exercises: items, templates: items }).parse(body);
    return;
  }
  if (path === '/api/v1/admin/accounts' || /\/groups\/\{group_id\}\/(?:members|candidates)$/.test(path)) {
    paged(account).parse(body);
    return;
  }
  if (path === '/api/v1/admin/groups') {
    paged(group).parse(body);
    return;
  }
  if (path === '/api/v1/admin/users') {
    paged(user).parse(body);
    return;
  }
  if (path === '/api/v1/admin/users/{user_id}') {
    userDetail.parse(body);
    return;
  }
  if (path === '/api/v1/admin/users/{user_id}/devices') {
    paged(device).parse(body);
    return;
  }
  if (path === '/api/v1/admin/audit-logs') {
    paged(audit).parse(body);
    return;
  }
  if (path === '/api/v1/admin/audit-actions') {
    z.array(identityOption).parse(body);
    return;
  }
  if (path === '/api/v1/admin/identity-types') {
    z.object({ items: z.array(identityOption) }).parse(body);
    return;
  }
  if (path === '/api/v1/admin/permission-catalog') catalog.parse(body);
};
