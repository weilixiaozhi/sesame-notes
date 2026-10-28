import type { PrismaClient } from '@prisma/client';
import type { FastifyRequest } from 'fastify';

import type { ApiConfig } from '../../shared/api-config.js';
import { ApiError } from '../../shared/errors.js';
import { currentSessionAccess } from './session-access.js';
import { verifyAccessToken, type AccessClaims } from './security.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AccessClaims;
  }
}

const USER_AUTHENTICATION_HOOKS = new WeakSet<object>();

/** 只识别本模块创建的真实守卫，函数名或路由自行附加属性不能伪装鉴权。 */
export function isUserAuthenticationHook(hook: unknown): boolean {
  return typeof hook === 'function' && USER_AUTHENTICATION_HOOKS.has(hook);
}

/** 按资源校验最小 scope 的前置守卫：读方法要求 read scope，写方法要求 write scope。 */
export function requireScopes(readScope: string, writeScope: string) {
  return async (request: FastifyRequest): Promise<void> => {
    try {
      const auth = requireAuth(request);
      const required = ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ? readScope : writeScope;
      if (!auth.scopes.includes(required)) {
        throw new ApiError(403, 'SCOPE_DENIED', '当前凭证无权执行此操作');
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      request.log.warn({ err: error, request_id: request.id }, 'scope 校验失败');
      throw new ApiError(403, 'SCOPE_DENIED', '当前凭证无权执行此操作');
    }
  };
}

/** 构造鉴权前置处理器，并把验证后的身份放入请求上下文。 */
export function authenticate(config: ApiConfig, prisma: PrismaClient) {
  const hook = async (request: FastifyRequest): Promise<void> => {
    let claims: AccessClaims;
    try {
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith('Bearer ')) throw new Error('缺少 Bearer Token');
      claims = await verifyAccessToken(authorization.slice(7), config);
    } catch (error) {
      request.log.warn({ err: error, request_id: request.id }, '访问令牌验证失败');
      throw new ApiError(401, 'UNAUTHORIZED', '请先登录');
    }
    try {
      // 已验签身份的安全状态读取失败时，响应阶段同步清理该用户的实时会话。
      request.realtimeRevalidationUserIds?.add(claims.userId);
      const access = await currentSessionAccess(prisma, claims);
      if (!access) throw new ApiError(401, 'UNAUTHORIZED', '请先登录');
      request.auth = claims;
      request.realtimeRevalidationUserIds?.delete(claims.userId);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'AUTH_UNAVAILABLE', '登录验证服务暂时不可用，请稍后重试', undefined, { cause: error });
    }
  };
  USER_AUTHENTICATION_HOOKS.add(hook);
  return hook;
}

/** 读取已认证身份；路由遗漏鉴权时立即失败，避免静默越权。 */
export function requireAuth(request: FastifyRequest): AccessClaims {
  if (!request.auth) throw new ApiError(401, 'UNAUTHORIZED', '请先登录');
  return request.auth;
}
