import { categoryState } from '../../shared/category-version.js';
import type { Category, Prisma } from '@prisma/client';

import { decimalToCanonical } from '../../shared/decimal.js';

/** 从持久化账本生成公共实体字段，个人归档和权限信息由各读取入口单独附加。 */
export function ledgerSnapshot(row: {
  id: string;
  ownerId: string;
  syncId: string;
  name: string;
  currency: string;
  monthStartDay: number;
  aaEnabled: boolean;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    owner_id: row.ownerId,
    // 云同步时间线身份：客户端 full 落库时据此建立/校验本地绑定
    sync_id: row.syncId,
    name: row.name,
    currency: row.currency,
    month_start_day: row.monthStartDay,
    aa_enabled: row.aaEnabled,
    updated_at: row.updatedAt.toISOString(),
  };
}

export function categorySnapshot(row: Category) {
  return categoryState(row);
}

export { mapRecurring as recurringSnapshot } from '../accounting/index.js';

/** 从持久化成员生成权威身份和生命周期字段，不接受请求载荷声明角色或账号绑定。 */
export function memberSnapshot(row: {
  id: string;
  ledgerId: string;
  displayName: string;
  memberType: string;
  linkedAccountId: string | null;
  role: string;
  status: string;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    ledger_id: row.ledgerId,
    display_name: row.displayName,
    member_type: row.memberType,
    linked_account_id: row.linkedAccountId,
    role: row.role,
    status: row.status,
    updated_at: row.updatedAt.toISOString(),
  };
}

export function rateSnapshot(row: {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
  rate: Prisma.Decimal;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    base_currency: row.baseCurrency,
    quote_currency: row.quoteCurrency,
    rate: decimalToCanonical(row.rate, 18),
    updated_at: row.updatedAt.toISOString(),
  };
}
