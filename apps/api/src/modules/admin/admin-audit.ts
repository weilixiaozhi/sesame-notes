import { Prisma, type PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import type { ApiConfig } from '../../shared/api-config.js';
import { ApiError } from '../../shared/errors.js';
import { execute } from '../../shared/execute.js';
import { adminPage, AdminPageQuery, validateAdminPaginationQuery, type AdminPageInput } from './admin-pagination.js';
import { authenticateAdmin } from './admin-security.js';
import { redactAuditText } from './audit-log.js';

const ADMIN_ACTION_LABELS: Readonly<Record<string, string>> = {
  'user.enable': '启用应用用户',
  'user.disable': '禁用应用用户',
  'user.phone.change': '换绑用户手机号',
  'user.password.reset': '重置应用用户密码',
  'user.avatar.update': '更换用户头像',
  'user.avatar.delete': '移除用户头像',
  'device.revoke': '撤销用户设备',
  'admin.login': '后台登录',
  'admin.login.failed': '后台登录失败',
  'admin.logout': '退出后台',
  'admin.password.change': '修改本人密码',
  'admin.password.reset': '重置后台用户密码',
  'admin.password_recovered': '恢复后台用户密码',
  'admin.bootstrap': '初始化后台用户',
  'admin.account.create': '创建后台用户',
  'admin.account.update': '修改后台用户',
  'admin.account.identity': '设置后台身份',
  'admin.account.delete': '删除后台用户',
  'admin.account.default_group_assigned': '分配默认用户组',
  'admin.group.create': '创建用户组',
  'admin.group.update': '修改用户组',
  'admin.group.delete': '删除用户组',
  'admin.group.permissions': '配置用户组权限',
  'admin.group.member.transfer': '调整用户组成员',
  'fitness.exercise.create': '新增动作',
  'fitness.exercise.update': '修改动作',
  'fitness.template.create': '新增训练模板',
  'fitness.template.update': '修改训练模板',
  'fitness.plan.create': '新增训练计划',
  'fitness.plan.update': '修改训练计划',
  'fitness.media.upload': '上传动作 GIF',
  'banner.update': '配置应用 Banner',
  'banner.create': '添加 Banner 图片',
  'banner.delete': '移除 Banner 图片',
  'banner.reset': '恢复 Banner 默认图片',
  'banner.media.upload': '上传 Banner 图片',
  'fitness.taxonomy.create': '新增部位或器械',
  'fitness.taxonomy.update': '修改部位或器械',
  'fitness.taxonomy.delete': '删除部位或器械',
};

/** 历史操作保留原始业务含义；当前操作目录只提供仍可执行的操作。 */
const AUDIT_HISTORY_LABELS: Readonly<Record<string, string>> = {
  ...ADMIN_ACTION_LABELS,
  'fitness.exercise.publish': '发布动作',
  'fitness.template.publish': '发布训练模板',
  'fitness.plan.publish': '发布训练计划',
};

const NullableText = Type.Union([Type.String(), Type.Null()]);
const AuditEntrySchema = Type.Object({
  id: Type.String(),
  ip: NullableText,
  created_at: Type.String({ format: 'date-time' }),
  action_label: Type.String(),
  actor_display: NullableText,
  target_display: NullableText,
  summary: NullableText,
  reason: NullableText,
});
const AuditListSchema = Type.Object({
  items: Type.Array(AuditEntrySchema),
  page: Type.Integer({ minimum: 1 }),
  page_size: Type.Integer({ minimum: 1 }),
  total: Type.Integer({ minimum: 0 }),
});

type AuditQuery = AdminPageInput & {
  action?: string;
  actor_search?: string;
  target_search?: string;
  created_from?: string;
  created_to?: string;
};
type AuditReadRow = {
  id: bigint;
  action: string;
  ip: string | null;
  created_at: Date;
  metadata: Prisma.JsonValue;
  actor_display: string | null;
  target_display: string | null;
};

/** 查询词中的 SQL 通配符作为普通字符匹配，参数始终绑定而不拼接进 SQL。 */
function searchPattern(value: string): string {
  return `%${value.trim().replace(/[\\%_]/g, (part) => `\\${part}`)}%`;
}

/** 操作者与对象优先使用写入快照，历史行只解析明确存在的关系。 */
const AUDIT_RELATIONS = Prisma.sql`
  FROM audit_logs l
  LEFT JOIN admin_accounts a ON l.actor = 'admin:' || a.id::text
  LEFT JOIN users u ON l.target->>'type' = 'user' AND l.target->>'id' = u.id::text
  LEFT JOIN user_profiles up ON up.user_id = u.id
  LEFT JOIN devices d ON l.target->>'type' = 'device' AND l.target->>'id' = d.id::text
  LEFT JOIN users du ON du.id = d.user_id
  LEFT JOIN user_profiles dp ON dp.user_id = du.id
  LEFT JOIN admin_accounts ta ON l.target->>'type' = 'admin_account' AND l.target->>'id' = ta.id::text
  LEFT JOIN admin_groups g ON l.target->>'type' = 'admin_group' AND l.target->>'id' = g.id::text`;
const ACTOR_DISPLAY = Prisma.sql`COALESCE(NULLIF(l.metadata->>'actor_username', ''), a.username)`;
const TARGET_DISPLAY = Prisma.sql`COALESCE(NULLIF(l.metadata->>'target_display', ''),
  CASE WHEN u.id IS NOT NULL THEN CONCAT_WS(' · ', NULLIF(up.display_name, ''), '芝麻号 ' || u.sesame_number)
       WHEN d.id IS NOT NULL THEN CONCAT_WS(' · ', NULLIF(d.name, ''), NULLIF(dp.display_name, ''), '芝麻号 ' || du.sesame_number)
       WHEN ta.id IS NOT NULL THEN ta.username WHEN g.id IS NOT NULL THEN g.name ELSE NULL END)`;

/** 计数和记录共用过滤片段，时间及业务名称在数据库分页前过滤。 */
export function adminAuditConditions(query: AuditQuery): Prisma.Sql {
  const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (query.action) conditions.push(Prisma.sql`l.action = ${query.action}`);
  if (query.actor_search?.trim())
    conditions.push(Prisma.sql`${ACTOR_DISPLAY} ILIKE ${searchPattern(query.actor_search)}`);
  if (query.target_search?.trim())
    conditions.push(Prisma.sql`${TARGET_DISPLAY} ILIKE ${searchPattern(query.target_search)}`);
  const from = query.created_from ? new Date(query.created_from) : null;
  const to = query.created_to ? new Date(query.created_to) : null;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime())) || (from && to && from > to))
    throw new ApiError(400, 'ADMIN_DATE_RANGE_INVALID', '请选择有效的时间范围');
  if (from) conditions.push(Prisma.sql`l.created_at >= ${from}`);
  if (to) conditions.push(Prisma.sql`l.created_at <= ${to}`);
  return Prisma.join(conditions, ' AND ');
}

/** 已批准的摘要文本按长度限制脱敏，未知元数据不进入响应。 */
function auditText(metadata: Record<string, Prisma.JsonValue>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? redactAuditText(value.trim()).slice(0, 500) : null;
}

/** 按事件构造业务摘要，禁止任意 JSON、身份代码和权限代码直接进入界面。 */
export function adminAuditSummary(action: string, metadata: Record<string, Prisma.JsonValue>): string | null {
  if (!Object.hasOwn(AUDIT_HISTORY_LABELS, action)) return null;
  const parts: string[] = [];
  if (action === 'banner.reset') parts.push('已恢复应用内置图片和默认入口');
  if (action === 'banner.delete') parts.push('已移除自定义图片');
  if (typeof metadata.is_enabled === 'boolean')
    parts.push(
      action === 'banner.update'
        ? `图片：${metadata.is_enabled ? '自定义' : '内置默认'}`
        : `状态：${metadata.is_enabled ? '启用' : '停用'}`,
    );
  if (action.startsWith('fitness.') && typeof metadata.enabled === 'boolean')
    parts.push(`状态：${metadata.enabled ? '启用' : '停用'}`);
  if (['fitness.media.upload', 'banner.media.upload'].includes(action) && typeof metadata.byte_size === 'number')
    parts.push(`素材大小：${Math.ceil(metadata.byte_size / 1024)} KB`);
  const group = auditText(metadata, 'group_name');
  if (group) parts.push(`用户组：${group}`);
  const previousGroup = auditText(metadata, 'previous_group_name');
  if (previousGroup && group && previousGroup !== group) parts.push(`原用户组：${previousGroup}`);
  const identity = metadata.identity_type;
  if (identity === 'super_admin' || identity === 'standard_user')
    parts.push(`身份：${identity === 'super_admin' ? '超级管理员' : '普通用户'}`);
  if (metadata.display_name_changed === true) parts.push('显示名称已修改');
  if (action === 'admin.account.update' && Array.isArray(metadata.changed_fields)) {
    if (metadata.changed_fields.includes('email')) parts.push('邮箱已修改，旧会话已撤销');
    if (metadata.changed_fields.includes('phone')) parts.push('手机号已修改，旧会话已撤销');
  }
  if (action === 'device.revoke') parts.push('此设备的登录已撤销');
  if (action === 'user.phone.change') parts.push('手机号已换绑，旧会话已撤销');
  if (action === 'user.avatar.update') parts.push('头像已更新');
  if (action === 'user.avatar.delete') parts.push('头像已移除');
  if (action === 'fitness.taxonomy.delete') {
    parts.push('分类已删除，动作和训练记录保留');
    if (typeof metadata.exercise_count === 'number' && metadata.exercise_count > 0)
      parts.push(`已迁移 ${metadata.exercise_count} 个动作`);
    if (typeof metadata.template_count === 'number' && metadata.template_count > 0)
      parts.push(`已调整 ${metadata.template_count} 个训练模板`);
  }
  if (
    ['admin.password.change', 'admin.password.reset', 'admin.password_recovered', 'user.password.reset'].includes(
      action,
    )
  )
    parts.push('密码已更新，旧会话已撤销');
  if (action === 'admin.group.permissions') parts.push('用户组权限与页面配置已更新');
  if (action === 'admin.account.delete' || action === 'admin.group.delete') parts.push('已删除，历史日志保留');
  return parts.length ? parts.join('；') : null;
}

/** 审计响应只输出业务展示字段，不用未知内部标识补充操作者或对象名称。 */
export function adminAuditResponse(row: AuditReadRow) {
  const metadata =
    row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, Prisma.JsonValue>)
      : {};
  return {
    id: row.id.toString(),
    ip: row.ip,
    created_at: row.created_at.toISOString(),
    action_label: Object.hasOwn(AUDIT_HISTORY_LABELS, row.action) ? AUDIT_HISTORY_LABELS[row.action]! : '其他操作',
    actor_display: row.actor_display ? redactAuditText(row.actor_display) : null,
    target_display: row.target_display ? redactAuditText(row.target_display) : null,
    summary: adminAuditSummary(row.action, metadata),
    reason: Object.hasOwn(AUDIT_HISTORY_LABELS, row.action) ? auditText(metadata, 'reason') : null,
  };
}

/** 操作日志总数及页码记录在同一可重复读事务中取得，筛选条件始终一致。 */
export function registerAdminAuditRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  app.get(
    '/api/v1/admin/audit-actions',
    {
      preHandler: [authenticateAdmin(config, prisma, 'audit:read')],
      schema: {
        tags: ['admin'],
        response: { 200: Type.Array(Type.Object({ value: Type.String(), label: Type.String() })) },
      },
    },
    async () => Object.entries(ADMIN_ACTION_LABELS).map(([value, label]) => ({ value, label })),
  );

  app.get(
    '/api/v1/admin/audit-logs',
    {
      preHandler: [authenticateAdmin(config, prisma, 'audit:read')],
      preValidation: validateAdminPaginationQuery,
      schema: {
        tags: ['admin'],
        querystring: Type.Object({
          ...AdminPageQuery,
          action: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          actor_search: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          target_search: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          created_from: Type.Optional(Type.String({ format: 'date-time' })),
          created_to: Type.Optional(Type.String({ format: 'date-time' })),
        }),
        response: { 200: AuditListSchema },
      },
    },
    async (request) =>
      execute(request, '查询操作日志', async () => {
        const query = request.query as AuditQuery;
        const conditions = adminAuditConditions(query);
        return prisma.$transaction(
          async (tx) => {
            const count = await tx.$queryRaw<Array<{ total: bigint }>>(
              Prisma.sql`SELECT COUNT(*) AS total ${AUDIT_RELATIONS} WHERE ${conditions}`,
            );
            const page = adminPage(query, Number(count[0]?.total ?? 0));
            const rows = await tx.$queryRaw<AuditReadRow[]>(Prisma.sql`
        SELECT l.id, l.action, l.ip, l.created_at,
          jsonb_build_object('reason', l.metadata->'reason', 'is_enabled', l.metadata->'is_enabled', 'group_name', l.metadata->'group_name', 'previous_group_name', l.metadata->'previous_group_name', 'identity_type', l.metadata->'identity_type', 'display_name_changed', l.metadata->'display_name_changed', 'enabled', l.metadata->'enabled', 'byte_size', l.metadata->'byte_size', 'changed_fields', l.metadata->'changed_fields', 'exercise_count', l.metadata->'exercise_count', 'template_count', l.metadata->'template_count') AS metadata,
          ${ACTOR_DISPLAY} AS actor_display, ${TARGET_DISPLAY} AS target_display
        ${AUDIT_RELATIONS} WHERE ${conditions} ORDER BY l.id DESC LIMIT ${page.page_size} OFFSET ${page.skip}`);
            return {
              items: rows.map(adminAuditResponse),
              page: page.page,
              page_size: page.page_size,
              total: page.total,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        );
      }),
  );
}
