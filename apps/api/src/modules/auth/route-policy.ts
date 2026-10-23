import type { FastifyInstance } from 'fastify';

import { isUserAuthenticationHook } from './guards.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    userAuthentication?: 'single-use-websocket-ticket';
  }
}

const PUBLIC_GET_PATHS = new Set([
  '/api/v1/health',
  '/api/v1/health/ready',
  '/api/v1/openapi.json',
  '/api/v1/invites/:code',
  '/api/v1/fitness/library',
  '/api/v1/fitness/catalog',
  '/api/v1/fitness/media/:media_id',
  '/api/v1/app/update.json',
  '/api/v1/app/download/:file',
]);
const PUBLIC_POST_PATHS = new Set([
  '/api/v1/auth/register',
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/auth/browser/register',
  '/api/v1/auth/browser/login',
  '/api/v1/auth/browser/refresh',
]);

/** 公开身份由准确的方法和路径共同决定，新增同路径写操作不会继承读取豁免。 */
export function isPublicUserRoute(method: string, url: string): boolean {
  return (
    (['GET', 'HEAD'].includes(method) && PUBLIC_GET_PATHS.has(url)) || (method === 'POST' && PUBLIC_POST_PATHS.has(url))
  );
}

/** 在路由装配阶段拒绝普通用户接口遗漏真实鉴权；后台由其独立身份策略负责。 */
export function enforceUserRouteProtection(app: FastifyInstance): void {
  try {
    app.addHook('onRoute', (route) => {
      if (
        (route.url !== '/api/v1' && !route.url.startsWith('/api/v1/')) ||
        route.url === '/api/v1/admin' ||
        route.url.startsWith('/api/v1/admin/')
      )
        return;
      const methods = (Array.isArray(route.method) ? route.method : [route.method]).map((method) =>
        method.toUpperCase(),
      );
      try {
        if (route.config?.userAuthentication !== undefined) {
          // WebSocket 在处理器内原子消费短票据并重查会话，成功后才 attach/send ready。
          // 此标记只批准现有握手端点，不能为其他API或同路径写请求豁免Bearer守卫。
          if (
            route.config.userAuthentication !== 'single-use-websocket-ticket' ||
            route.url !== '/api/v1/ws' ||
            !methods.every((method) => ['GET', 'HEAD'].includes(method)) ||
            !('websocket' in route) ||
            route.websocket !== true
          ) {
            throw new Error('WebSocket 票据鉴权标记只能用于 GET 握手端点');
          }
          return;
        }
        if (methods.every((method) => isPublicUserRoute(method, route.url))) return;
        const hooks =
          route.preHandler === undefined ? [] : Array.isArray(route.preHandler) ? route.preHandler : [route.preHandler];
        if (hooks.filter(isUserAuthenticationHook).length !== 1) {
          throw new Error('普通用户业务路由必须声明一个真实 authenticate 守卫');
        }
      } catch (cause) {
        app.log.error({ err: cause, route: route.url, methods }, '普通用户路由安全注册失败');
        throw new Error(`普通用户路由鉴权声明无效：${methods.join(',')} ${route.url}`, { cause });
      }
    });
  } catch (cause) {
    throw new Error('无法安装普通用户路由安全门禁', { cause });
  }
}
