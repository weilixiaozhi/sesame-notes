import type { Prisma, PrismaClient } from '@prisma/client';

type AuditLogInput = {
  /** 新后台操作为 admin:<管理员 id>；历史用户 id 保留原义，系统动作可传 system。 */
  actor: string;
  /** 动作名，如 'user.disable'，查询端按精确匹配过滤。 */
  action: string;
  /** 被操作对象：{ type: 'user' | 'device' | ..., id }。 */
  target: { type: string; id: string };
  requestId: string;
  ip?: string | null;
  metadata?: Prisma.JsonValue;
};

/** 日志自由文本不保存完整手机号；业务对象使用昵称和芝麻号定位。 */
export function redactAuditText(value: string): string {
  return value.replace(/\+\d[\d -]{6,}\d|\b1[3-9]\d{9}\b/g, (phone) => `${phone.slice(0, 3)}****${phone.slice(-4)}`);
}

/** 资料名称按纯文本截断并脱敏，防止日志中扩大无关的个人信息。 */
function displayText(value: string | null | undefined): string | null {
  return value?.trim() ? redactAuditText(value.trim()).slice(0, 200) : null;
}

/** 应用用户以业务编号和昵称构造可追溯名称，永远不以手机号或内部 ID 补位。 */
function auditUserDisplay(user: { sesameNumber: string; profile: { displayName: string | null } | null }): string {
  const name = displayText(user.profile?.displayName);
  return name ? `${name}（芝麻号 ${user.sesameNumber}）` : `芝麻号 ${user.sesameNumber}`;
}

/** 在当前事务读取真实业务对象，形成写入时快照，重命名和软删除不会改变旧记录。 */
async function auditTargetDisplay(
  tx: PrismaClient | Prisma.TransactionClient,
  target: AuditLogInput['target'],
  metadata?: Prisma.JsonValue,
): Promise<string | null> {
  if (target.type === 'app_banner') {
    const slot =
      target.id === 'fitness-plan-library' || target.id === 'fitness-template-library'
        ? target.id
        : (await tx.appBanner.findUnique({ where: { id: target.id }, select: { slot: true } }))?.slot;
    return slot === 'fitness-plan-library' ? '计划库入口' : slot === 'fitness-template-library' ? '模板库入口' : null;
  }
  if (target.type === 'app_banner_slot') return target.id === 'fitness-plan-library' ? '计划库入口' : '模板库入口';
  if (target.type === 'banner_media') {
    return displayText(
      (await tx.appBannerMedia.findUnique({ where: { id: target.id }, select: { fileName: true } }))?.fileName,
    );
  }
  if (target.type === 'fitness_taxonomy') {
    const kind = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata.kind : null;
    if (kind !== 'body_part' && kind !== 'equipment') return null;
    const taxon = await tx.officialFitnessTaxon.findUnique({
      where: { kind_id: { kind, id: target.id } },
      select: { nameZh: true },
    });
    return displayText(taxon?.nameZh);
  }
  if (target.type === 'admin_account') {
    return displayText(
      (await tx.adminAccount.findUnique({ where: { id: target.id }, select: { username: true } }))?.username,
    );
  }
  if (target.type === 'admin_group') {
    return displayText((await tx.adminGroup.findUnique({ where: { id: target.id }, select: { name: true } }))?.name);
  }
  if (target.type === 'fitness_media') {
    return displayText(
      (await tx.officialFitnessMedia.findUnique({ where: { id: target.id }, select: { fileName: true } }))?.fileName,
    );
  }
  if (['fitness_exercise', 'fitness_template', 'fitness_plan'].includes(target.type)) {
    const row = await tx.officialFitnessContent.findUnique({ where: { id: target.id }, select: { content: true } });
    const content = row?.content;
    if (content && typeof content === 'object' && !Array.isArray(content)) {
      const localized = content.name;
      const name =
        target.type === 'fitness_exercise'
          ? content.name_zh
          : localized && typeof localized === 'object' && !Array.isArray(localized)
            ? localized.zh
            : null;
      return typeof name === 'string' ? displayText(name) : null;
    }
    return null;
  }
  if (target.type === 'user') {
    const user = await tx.user.findUnique({
      where: { id: target.id },
      select: { sesameNumber: true, profile: { select: { displayName: true } } },
    });
    return user ? auditUserDisplay(user) : null;
  }
  if (target.type === 'device') {
    const device = await tx.device.findUnique({
      where: { id: target.id },
      select: { name: true, user: { select: { sesameNumber: true, profile: { select: { displayName: true } } } } },
    });
    return device ? `${displayText(device.name) ?? '未提供设备名称'} · ${auditUserDisplay(device.user)}` : null;
  }
  return null;
}

/** 服务端元数据按递归规则清除凭据键并脱敏文本，显示端另用事件白名单。 */
function safeAuditMetadata(value: Prisma.JsonValue): Prisma.InputJsonValue | null {
  if (typeof value === 'string') return redactAuditText(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(safeAuditMetadata);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/password|token|secret|hash|cookie|phone|ai.?config/i.test(key))
      .map(([key, item]) => [key, safeAuditMetadata(item ?? null)]),
  );
}

/** 写入一条追加型审计记录；audit_logs 表由数据库触发器禁止 UPDATE/DELETE， 因此这里只允许新增，保证审计轨迹不可篡改。 */
export async function writeAuditLog(tx: PrismaClient | Prisma.TransactionClient, input: AuditLogInput): Promise<void> {
  try {
    const adminId = input.actor.startsWith('admin:') ? input.actor.slice(6) : null;
    const actor = adminId
      ? await tx.adminAccount.findUnique({ where: { id: adminId }, select: { username: true } })
      : null;
    const targetDisplay = await auditTargetDisplay(tx, input.target, input.metadata);
    const metadata =
      input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata : {};
    await tx.auditLog.create({
      data: {
        actor: input.actor,
        action: input.action,
        target: input.target as Prisma.InputJsonValue,
        requestId: input.requestId,
        ip: input.ip ?? null,
        metadata: safeAuditMetadata({
          ...metadata,
          actor_username: actor?.username ?? null,
          target_display: targetDisplay,
        }) as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    // 调用方把审计与受保护修改放在同一事务；写审计失败时必须整体回滚。
    throw new Error('审计记录写入失败', { cause: error });
  }
}
