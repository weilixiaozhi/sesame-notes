import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../../shared/api-config.js';
import { registerAccountingFullRoutes } from './accounting-full-routes.js';
import { registerFullRoutes } from './full-routes.js';
import { registerPullRoutes } from './pull-routes.js';

type Route = { schema: Record<string, any>; handle: (request: FastifyRequest) => Promise<any> };

/** 装配真实同步路由，数据库查询由内存替身提供，避免访问共享测试库。 */
function routes(findMany = vi.fn().mockResolvedValue([]), cutoverCursor = 0n) {
  const registered = new Map<string, Route>();
  const app = {
    /** 保留真实路由的契约与业务处理器，测试直接调用认证后的业务入口。 */
    get(path: string, options: { schema: Route['schema'] }, handle: Route['handle']) {
      registered.set(path, { schema: options.schema, handle });
    },
  } as unknown as FastifyInstance;
  const prisma = {
    syncChange: { findMany },
    $queryRaw: vi.fn().mockResolvedValue([{ cursor: cutoverCursor, completedAt: new Date(0) }]),
  } as unknown as PrismaClient;
  const config = { syncRetentionMinCursor: 0 } as ApiConfig;
  registerPullRoutes(app, prisma, config);
  registerFullRoutes(app, prisma, config);
  registerAccountingFullRoutes(app, prisma, config);
  return registered;
}

/** 构造已经通过认证的请求，业务处理仍走真实执行器和归属转换。 */
function request(): FastifyRequest {
  return {
    auth: { userId: 'viewer' },
    headers: {},
    query: { since: '0' },
    log: { child: vi.fn().mockReturnValue({}) },
  } as unknown as FastifyRequest;
}

describe('统一分类归属协议', () => {
  it('三个同步入口使用唯一协议，快照墓碑必填且账号快照不输出重复编号镜像', () => {
    const registered = routes();
    for (const route of registered.values()) expect(route.schema.headers).toBeUndefined();
    const full = registered.get('/api/v1/sync/full')!.schema.response[200];
    const accounting = registered.get('/api/v1/sync/accounting/full')!.schema.response[200];
    expect(full.required).toContain('category_tombstones');
    expect(accounting.required).toContain('category_tombstones');
    expect(accounting.properties.deleted_category_ids).toBeUndefined();
    expect(accounting.properties.ledger_snapshots.items.required).toContain('category_tombstones');
  });

  it('普通请求查询授权共享分类并读取当前事件的权威归属载荷', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        changeId: 12n,
        entityType: 'category',
        entityId: 'category',
        action: 'delete',
        payload: { owner_id: 'owner' },
        userId: 'owner',
        updatedAt: new Date('2026-10-19T12:00:00Z'),
      },
    ]);
    const result = await routes(findMany).get('/api/v1/sync/pull')!.handle(request());
    const where = findMany.mock.calls[0]![0].where;
    expect(where.NOT).toBeUndefined();
    expect(where.OR).toContainEqual({
      ledgerId: null,
      entityType: 'category',
      user: {
        ownedLedgers: {
          some: {
            deletedAt: null,
            members: { some: { linkedAccountId: 'viewer', memberType: 'REGISTERED', status: 'ACTIVE' } },
          },
        },
      },
    });
    expect(result.changes[0].payload.owner_id).toBe('owner');
    expect(result.server_cursor).toBe('12');
  });

  it('切点前请求要求完整同步，不读取或修补旧载荷', async () => {
    const findMany = vi.fn();
    await expect(routes(findMany, 12n).get('/api/v1/sync/pull')!.handle(request())).rejects.toMatchObject({
      statusCode: 410,
      code: 'SYNC_CURSOR_EXPIRED',
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('查询失败沿唯一执行边界报错，不能返回空目录或推进游标', async () => {
    const failure = new Error('database unavailable');
    const findMany = vi.fn().mockRejectedValue(failure);
    await expect(routes(findMany).get('/api/v1/sync/pull')!.handle(request())).rejects.toMatchObject({
      code: 'SYNC_FAILED',
      cause: failure,
    });
  });
});
