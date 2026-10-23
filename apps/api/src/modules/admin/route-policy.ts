import type { FastifyInstance } from 'fastify';

import { getAdminAuthenticationPolicy } from './admin-security.js';

/** 在注册时阻止遗漏鉴权或权限声明的后台路由；新增路由不能默认公开。 */
export function enforceAdminRouteProtection(app: FastifyInstance): void {
  app.addHook('onRoute', (route) => {
    if (route.url !== '/api/v1/admin' && !route.url.startsWith('/api/v1/admin/')) return;
    const methods = (Array.isArray(route.method) ? route.method : [route.method]).map((method) => method.toUpperCase());
    if (route.url === '/api/v1/admin/auth/login' && methods.every((method) => method === 'POST')) return;

    const hooks =
      route.preHandler === undefined ? [] : Array.isArray(route.preHandler) ? route.preHandler : [route.preHandler];
    const policies = hooks.map((hook) => getAdminAuthenticationPolicy(hook)).filter((policy) => policy !== undefined);
    if (policies.length !== 1)
      throw new Error(`后台路由必须声明一个独立管理员鉴权守卫：${methods.join(',')} ${route.url}`);
    const policy = policies[0]!;
    const isIdentity =
      route.url === '/api/v1/admin/auth/me' && methods.every((method) => ['GET', 'HEAD'].includes(method));
    if (policy.permission === undefined && !isIdentity)
      throw new Error(`后台业务路由必须声明具体权限：${methods.join(',')} ${route.url}`);

    if (
      (policy.permission === 'auth:password' && route.url !== '/api/v1/admin/auth/password') ||
      (policy.permission === 'auth:logout' && route.url !== '/api/v1/admin/auth/logout')
    )
      throw new Error(`本人权限只能用于对应本人接口：${route.url}`);
    if (
      methods.some((method) => !['GET', 'HEAD', 'OPTIONS'].includes(method)) &&
      ['users:read', 'devices:read', 'status:read', 'audit:read', 'analytics:read', 'fitness:read'].includes(
        policy.permission ?? '',
      ) &&
      // 漏斗 POST 只承载有长度和窗口限制的只读查询，不修改统计或管理数据。
      !(
        route.url === '/api/v1/admin/analytics/funnel' &&
        policy.permission === 'analytics:read' &&
        methods.every((method) => method === 'POST')
      )
    )
      throw new Error(`后台写接口不能使用只读权限：${route.url}`);
  });
}
