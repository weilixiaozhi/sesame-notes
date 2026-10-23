import { CategoryConflictSchema, CategoryResolutionSchema } from './shared/contracts/category-conflicts.js';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';

import swagger from '@fastify/swagger';
import websocket from '@fastify/websocket';
import { PrismaClient } from '@prisma/client';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

import { loadConfig, type ApiConfig } from './config.js';
import { registerMaintenance } from './maintenance.js';
import { registerAccountRoutes } from './modules/accounts/index.js';
import {
  enforceAdminRouteProtection,
  registerAdminAccountRoutes,
  registerAdminAuthRoutes,
  registerAdminRoutes,
} from './modules/admin/index.js';
import { registerAppReleaseRoutes } from './modules/app-release/index.js';
import { registerAnalyticsRoutes } from './modules/analytics/index.js';
import {
  currentSessionAccess,
  enforceUserRouteProtection,
  isPublicUserRoute,
  registerAuthRoutes,
} from './modules/auth/index.js';
import { registerImportRoutes } from './modules/imports/index.js';
import { ensureDefaultCategories, registerAccountingRoutes } from './modules/accounting/index.js';
import { registerSyncRoutes } from './modules/sync/index.js';
import { registerSharingRoutes } from './modules/sharing/index.js';
import { RealtimeHub, registerRealtimeRoutes } from './modules/realtime/index.js';
import {
  registerFitnessLibraryRoutes,
  registerOfficialFitnessRoutes,
  registerOfficialFitnessMediaRoutes,
  registerFitnessPlanRoutes,
  registerFitnessStatisticsRoutes,
  registerFitnessTransferRoutes,
} from './modules/fitness/index.js';
import { ApiError, registerErrorHandler } from './shared/errors.js';
import { safeRequestUrl, serializeAdminError, serializeRequest } from './shared/request-logging.js';
import { createRateLimit } from './shared/rate-limit.js';
import { runWithRealtimeContext } from './shared/realtime-context.js';
import { runWithOperationMetrics } from './shared/operation-metrics.js';
import {
  CategorySchema,
  ExchangeRateOverrideSchema,
  LedgerSchema,
  MemberSchema,
  RecurringTransactionSchema,
  TransactionSchema,
  TransactionSplitSchema,
} from './shared/contracts/accounting.js';
import { ErrorSchema } from './shared/contracts/errors.js';

type BuildAppOptions = {
  logger?: boolean | FastifyBaseLogger;
  config?: ApiConfig;
  prisma?: PrismaClient;
};

/** 构建 Fastify 应用；依赖注入仅用于测试复用同一真实路由，不创建平行实现。 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  try {
    const config = options.config ?? loadConfig();
    const prisma = options.prisma ?? new PrismaClient({ datasourceUrl: config.databaseUrl });
    const app = Fastify({
      ...(typeof options.logger === 'object'
        ? { loggerInstance: options.logger.child({}, { serializers: { req: serializeRequest } }) }
        : { logger: options.logger === false ? false : { serializers: { req: serializeRequest } } }),
      requestIdHeader: 'x-request-id',
      // 只信任宿主机反向代理所在网段；未配置时 X-Forwarded-For 等转发头一律无效
      trustProxy: config.trustProxyCidrs.length > 0 ? config.trustProxyCidrs : false,
    }).withTypeProvider<TypeBoxTypeProvider>();
    enforceAdminRouteProtection(app);
    enforceUserRouteProtection(app);
    const realtimeHub = new RealtimeHub(
      async (claims) => await currentSessionAccess(prisma, claims),
      (error) => app.log.error({ err: error }, '实时会话安全状态检查失败'),
    );
    const stopMaintenance = registerMaintenance(app, prisma, config.storagePath);

    app.decorateRequest('syncChangeIds');
    app.decorateRequest('operationMetrics');
    app.decorateRequest('realtimeRevalidationUserIds');
    app.addHook('onRequest', (request, _reply, done) => {
      // 日志与后台策略使用同一规范路径，编码后的路由也必须过滤异常中的个人资料。
      if (safeRequestUrl(request.url) === '/api/v1/admin') {
        request.log = request.log.child(
          {},
          { serializers: { err: serializeAdminError, original_error: serializeAdminError } },
        );
      }
      request.syncChangeIds = new Set<bigint>();
      request.operationMetrics = {};
      request.realtimeRevalidationUserIds = new Set<string>();
      runWithOperationMetrics(request.operationMetrics, () => runWithRealtimeContext(request.syncChangeIds, done));
    });

    void app.register(cookie);
    void app.register(cors, {
      // 白名单来源之外的浏览器请求不带 CORS 头；移动端无 Origin 概念不受影响
      origin:
        [...config.corsOrigins, ...(config.adminOrigins ?? [])].length > 0
          ? [...new Set([...config.corsOrigins, ...(config.adminOrigins ?? [])])]
          : false,
      credentials: true,
    });
    void app.register(websocket, { options: { maxPayload: 64 * 1024 } });
    void app.register(swagger, {
      openapi: {
        openapi: '3.0.3',
        // 当前契约版本，与契约包版本同步维护。
        info: { title: 'Sesame Notes API', version: '2.0.0' },
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
            adminSessionAuth: {
              type: 'apiKey',
              in: 'cookie',
              name: '__Secure-sesame_admin_session',
              description:
                '独立管理员会话；不接受普通用户 Bearer JWT。浏览器写请求同时要求 X-Admin-Request: 1 与后台来源白名单。',
            },
          },
        },
        tags: [
          { name: 'auth', description: '认证与令牌轮换' },
          { name: 'profile', description: '个人资料' },
          { name: 'ledgers', description: '账本' },
          { name: 'transactions', description: '交易' },
          { name: 'categories', description: '分类' },
          { name: 'sync', description: '离线同步' },
          { name: 'fitness', description: '训练内容库' },
          { name: 'admin', description: '系统管理（管理员）' },
          { name: 'admin-auth', description: '独立后台用户认证与会话' },
          { name: 'admin-accounts', description: '后台用户与身份维护（超级管理员）' },
          { name: 'admin-groups', description: '自定义用户组与授权维护（超级管理员）' },
        ],
      },
      refResolver: {
        buildLocalReference(json, _baseUri, _fragment, index) {
          return typeof json.$id === 'string' ? json.$id : `Schema${index}`;
        },
      },
      transform: ({ schema, url, route }) => {
        const errorResponse = Type.Ref(ErrorSchema);
        const responses = (schema.response ?? {}) as Record<string, object>;
        return {
          url,
          schema: {
            ...schema,
            operationId: schema.operationId ?? createOperationId(route.method, url),
            security: isPublicApiRoute(route.method, url)
              ? []
              : url.startsWith('/api/v1/admin/')
                ? [{ adminSessionAuth: [] }]
                : [{ bearerAuth: [] }],
            response: {
              ...responses,
              400: responses['400'] ?? errorResponse,
              401: responses['401'] ?? errorResponse,
              403: responses['403'] ?? errorResponse,
              404: responses['404'] ?? errorResponse,
              409: responses['409'] ?? errorResponse,
              429: responses['429'] ?? {
                ...errorResponse,
                description: '请求频率超过限制，请按 Retry-After 指示重试。',
                headers: { 'Retry-After': { type: 'string', description: '距离允许重试的秒数' } },
              },
              500: responses['500'] ?? errorResponse,
              503: responses['503'] ?? errorResponse,
            },
          },
        };
      },
      /** 路由在校验前规范缺省正文时，将相同的可选语义写入生成契约。 */
      transformObject(document) {
        if (!('openapiObject' in document)) return document.swaggerObject;
        const output = document.openapiObject;
        try {
          for (const path of Object.values(output.paths ?? {})) {
            for (const method of ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const) {
              const operation = path?.[method];
              if (!operation) continue;
              const annotated = operation as typeof operation & { 'x-optional-request-body'?: boolean };
              if (annotated['x-optional-request-body'] !== true) continue;
              if (!annotated.requestBody || '$ref' in annotated.requestBody) {
                throw new Error('可选请求体标记必须对应路由内定义的正文 Schema');
              }
              annotated.requestBody.required = false;
              delete annotated['x-optional-request-body'];
            }
          }
          return output;
        } catch (cause) {
          throw new Error('可选请求体契约生成失败，请检查路由声明', { cause });
        }
      },
    });

    // 全局限流：宽松阈值防批量滥用，敏感接口在路由级使用更严的阈值
    const globalRateLimit = createRateLimit(config.rateLimitMax, 60_000);
    app.addHook('onRequest', async (request, reply) => {
      try {
        reply.header('x-request-id', request.id);
        if (safeRequestUrl(request.url) === '/api/v1/admin') {
          reply.header('cache-control', 'no-store');
          reply.header('pragma', 'no-cache');
        }
        await globalRateLimit(request, reply);
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 429) throw error;
        request.log.error({ err: error, request_id: request.id }, '请求前置处理失败');
        throw error;
      }
    });

    app.addHook('onResponse', async (request) => {
      if (request.realtimeRevalidationUserIds.size) {
        await realtimeHub.revalidate(request.realtimeRevalidationUserIds);
      }
      await realtimeHub.publishForWrite(request, prisma);
      if (Object.keys(request.operationMetrics).length) {
        request.log.info({ operations: request.operationMetrics }, '请求事务与快照指标');
      }
    });

    registerErrorHandler(app);
    // 框架默认的 404 文案会包含完整 URL；统一业务错误避免把查询中的隐私复制到日志和响应。
    app.setNotFoundHandler(() => {
      throw new ApiError(404, 'NOT_FOUND', '请求的内容不存在');
    });

    // Swagger 必须先完成注册再声明路由，否则它的 onRoute 钩子无法收集契约。
    void app.register(async (api) => {
      api.addSchema(ErrorSchema);
      api.addSchema(LedgerSchema);
      api.addSchema(TransactionSplitSchema);
      api.addSchema(TransactionSchema);
      api.addSchema(MemberSchema);
      api.addSchema(CategorySchema);
      api.addSchema(CategoryConflictSchema);
      api.addSchema(CategoryResolutionSchema);
      api.addSchema(RecurringTransactionSchema);
      api.addSchema(ExchangeRateOverrideSchema);

      api.get(
        '/api/v1/health',
        {
          schema: {
            tags: ['system'],
            response: {
              200: {
                type: 'object',
                required: ['status', 'request_id'],
                properties: { status: { type: 'string' }, request_id: { type: 'string' } },
              },
            },
          },
        },
        // liveness：只证明 HTTP 进程存活，不探测数据库。
        async (request) => ({ status: 'ok', request_id: request.id }),
      );

      api.get(
        '/api/v1/health/ready',
        {
          schema: {
            tags: ['system'],
            response: {
              200: {
                type: 'object',
                required: ['status', 'request_id'],
                properties: { status: { type: 'string' }, request_id: { type: 'string' } },
              },
              503: {
                type: 'object',
                required: ['status', 'request_id'],
                properties: { status: { type: 'string' }, request_id: { type: 'string' } },
              },
            },
          },
        },
        // readiness：检查数据库连通性和代际单例行，供容器健康检查使用。
        async (request, reply) => {
          try {
            await prisma.$queryRaw`SELECT 1`;
            // 仅确认 server_epochs 单例行存在且可读，不验证全部业务表或不变量定义。
            const epoch = await prisma.serverEpoch.findUnique({ where: { id: 0 } });
            if (!epoch) throw new Error('server_epochs 单例行缺失，数据库尚未完成迁移');
            return { status: 'ok', request_id: request.id };
          } catch (error) {
            request.log.warn({ err: error, request_id: request.id }, 'readiness 探测失败：数据库不可用');
            return await reply.status(503).send({ status: 'unavailable', request_id: request.id });
          }
        },
      );

      api.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());

      registerAuthRoutes(api, prisma, config, ensureDefaultCategories);
      registerAdminAuthRoutes(api, prisma, config);
      registerAdminAccountRoutes(api, prisma, config);
      registerAdminRoutes(api, prisma, config);
      registerAnalyticsRoutes(api, prisma, config);
      registerAccountRoutes(api, prisma, config);
      registerAccountingRoutes(api, prisma, config);
      registerSharingRoutes(api, prisma, config);
      registerSyncRoutes(api, prisma, config);
      registerFitnessLibraryRoutes(api, prisma);
      registerOfficialFitnessRoutes(api, prisma, config);
      registerOfficialFitnessMediaRoutes(api, prisma, config);
      registerFitnessPlanRoutes(api, prisma, config);
      registerFitnessStatisticsRoutes(api, prisma, config);
      registerFitnessTransferRoutes(api, prisma, config);
      registerImportRoutes(api, prisma, config);
      registerAppReleaseRoutes(api, config);
      registerRealtimeRoutes(api, prisma, config, realtimeHub);
    });

    app.addHook('onClose', async () => {
      try {
        await stopMaintenance();
        realtimeHub.close();
        await prisma.$disconnect();
      } catch (error) {
        app.log.error({ err: error }, '数据库连接关闭失败');
        throw error;
      }
    });
    return app;
  } catch (error) {
    throw new Error('Fastify 应用构建失败', { cause: error });
  }
}

/** 公开入口集合；受保护操作按用户 Bearer 与管理员 Cookie 两个身份域分别声明。 */
function isPublicApiRoute(method: string | string[], url: string): boolean {
  const methods = (Array.isArray(method) ? method : [method]).map((value) => value.toUpperCase());
  return methods.every(
    (value) => isPublicUserRoute(value, url) || (value === 'POST' && url === '/api/v1/admin/auth/login'),
  );
}

/** 由 HTTP 方法和规范路径生成稳定 operationId，避免人工命名遗漏或重复。 */
function createOperationId(method: string | string[], url: string): string {
  const routeMethod = Array.isArray(method) ? method[0] : method;
  if (!routeMethod) throw new Error(`无法为路由 ${url} 生成 operationId`);
  const verb = routeMethod.toLowerCase();
  const resource = url
    .replace(/^\/api\/v1\/?/, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const parameter = segment.startsWith(':');
      const words = (parameter ? segment.slice(1) : segment).split(/[-_]/).filter(Boolean);
      const name = words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join('');
      return parameter ? `By${name}` : name;
    })
    .join('');
  return `${verb}${resource}`;
}
