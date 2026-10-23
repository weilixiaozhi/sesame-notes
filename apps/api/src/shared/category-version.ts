import type { Category } from '@prisma/client';
import { requestFingerprint } from './request-fingerprint.js';

/** 分类基线绑定账号、身份、完整内容与墓碑；历史事件只能携带事件写入时的基线。 */
export function categoryVersionToken(row: Category): string {
  return requestFingerprint({
    owner_id: row.ownerId,
    id: row.id,
    name: row.name,
    kind: row.kind,
    level: row.level,
    sort_order: row.sortOrder,
    icon: row.icon,
    parent_id: row.parentId,
    updated_at: row.updatedAt.toISOString(),
    updated_by_device_id: row.updatedByDeviceId,
    deleted_at: row.deletedAt?.toISOString() ?? null,
  });
}

/** REST、完整同步、增量事件与确认回执共用同一权威分类形状。 */
export function categoryState(row: Category) {
  return {
    id: row.id,
    owner_id: row.ownerId,
    name: row.name,
    kind: row.kind,
    level: row.level,
    sort_order: row.sortOrder,
    icon: row.icon,
    parent_id: row.parentId,
    updated_at: row.updatedAt.toISOString(),
    deleted_at: row.deletedAt?.toISOString() ?? null,
    version_token: categoryVersionToken(row),
  };
}
