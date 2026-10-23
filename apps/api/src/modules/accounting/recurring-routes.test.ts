import type { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../../shared/api-config.js';
import { RecurringTransactionSchema } from '../../shared/contracts/accounting.js';
import { ErrorSchema } from '../../shared/contracts/errors.js';
import { registerErrorHandler } from '../../shared/errors.js';
import { registerRecurringRoutes } from './recurring-routes.js';

const ledgerId = '11111111-1111-4111-8111-111111111111';
vi.mock('../auth/index.js', () => ({
  authenticate: () => async () => {},
  requireScopes: () => async () => {},
  requireAuth: () => ({ userId: '22222222-2222-4222-8222-222222222222' }),
  currentSessionAccess: vi.fn(),
}));
vi.mock('./domain/ledger-access.js', () => ({
  getLedgerReadAccess: async () => ({ ledger: { syncId: '33333333-3333-4333-8333-333333333333' } }),
  getLedgerWriteAccess: vi.fn(),
}));

/** 仅替代数据库和授权读取，保留真实路由、游标校验及错误响应。 */
async function withApplication(
  work: (app: ReturnType<typeof Fastify>, read: ReturnType<typeof vi.fn>) => Promise<void>,
) {
  const app = Fastify({ logger: false });
  try {
    const read = vi.fn().mockResolvedValue([]);
    const tx = { recurringTransaction: { findMany: read } };
    const db = { $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx) };
    app.addSchema(RecurringTransactionSchema);
    app.addSchema(ErrorSchema);
    registerErrorHandler(app);
    registerRecurringRoutes(app, db as unknown as PrismaClient, {} as ApiConfig);
    await work(app, read);
  } catch (cause) {
    throw new Error('周期分页请求回归测试失败', { cause });
  } finally {
    await app.close();
  }
}

describe('周期账单游标', () => {
  it.each(['a'.repeat(36), '-'.repeat(36), '111111111-111-4111-8111-111111111111'])(
    '拒绝非 UUID 游标且不查询记录：%s',
    async (raw) => {
      await withApplication(async (app, read) => {
        const response = await app.inject({
          url: `/api/v1/ledgers/${ledgerId}/recurring-transactions?cursor=${Buffer.from(raw).toString('base64url')}`,
        });
        expect(response.statusCode, response.body).toBe(400);
        expect(response.json().code).toBe('INVALID_CURSOR');
        expect(read).not.toHaveBeenCalled();
      });
    },
  );

  it('合法 UUID 游标保持严格递增分页条件', async () => {
    await withApplication(async (app, read) => {
      const response = await app.inject({
        url: `/api/v1/ledgers/${ledgerId}/recurring-transactions?cursor=${Buffer.from(ledgerId).toString('base64url')}`,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(read).toHaveBeenCalledWith({
        where: { ledgerId, deletedAt: null, id: { gt: ledgerId } },
        orderBy: { id: 'asc' },
        take: 101,
      });
    });
  });
});
