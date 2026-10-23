import { Prisma, type PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

import type { ApiConfig } from '../../shared/api-config.js';
import { execute } from '../../shared/execute.js';
import { registerAdminAuditRoutes } from './admin-audit.js';
import { authenticateAdmin } from './admin-security.js';
import { registerAdminUserRoutes } from './admin-users.js';

const SystemStatusSchema = Type.Object({
  users: Type.Object({
    total: Type.Integer(),
    enabled: Type.Integer(),
  }),
  admins: Type.Object({ total: Type.Integer(), enabled: Type.Integer() }),
  ledgers: Type.Object({ total: Type.Integer() }),
  devices: Type.Object({ total: Type.Integer() }),
  sync_changes: Type.Object({ total: Type.Integer() }),
  audit_logs: Type.Object({ total: Type.Integer() }),
});

/** 装配管理业务路由，汇总统计只保留未删除的后台账号。 */
export function registerAdminRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  registerAdminUserRoutes(app, prisma, config);
  registerAdminAuditRoutes(app, prisma, config);
  app.get(
    '/api/v1/admin/status',
    {
      preHandler: [authenticateAdmin(config, prisma, 'status:read')],
      schema: { tags: ['admin'], response: { 200: SystemStatusSchema } },
    },
    async (request) =>
      execute(request, '查询管理统计', async () =>
        prisma.$transaction(
          async (tx) => {
            const [total, enabled, admins, enabledAdmins, ledgers, devices, syncChanges, auditLogs] = await Promise.all(
              [
                tx.user.count(),
                tx.user.count({ where: { isEnabled: true } }),
                tx.adminAccount.count({ where: { deletedAt: null } }),
                tx.adminAccount.count({ where: { deletedAt: null, isEnabled: true } }),
                tx.ledger.count(),
                tx.device.count(),
                tx.syncChange.count(),
                tx.auditLog.count(),
              ],
            );
            return {
              users: { total, enabled },
              admins: { total: admins, enabled: enabledAdmins },
              ledgers: { total: ledgers },
              devices: { total: devices },
              sync_changes: { total: syncChanges },
              audit_logs: { total: auditLogs },
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        ),
      ),
  );
}
