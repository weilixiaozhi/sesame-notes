import type { PrismaClient } from '@prisma/client';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ApiError } from '../src/shared/errors.js';

const apps: ReturnType<typeof buildApp>[] = [];
const requestId = 'request-parser-test';
const sensitiveValue = 'private-password-never-return';

/** 使用真实 Fastify 请求解析器和全局错误边界，数据库仅记录是否进入业务处理。 */
function setup(failure?: Error) {
  try {
    const prisma = {
      user: { findUnique: vi.fn() },
      $transaction: vi.fn(),
      $disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const app = buildApp({
      logger: false,
      config: loadConfig({
        DATABASE_URL: 'postgresql://unused:unused@localhost:1/unused',
        JWT_SECRET: 'request-errors-test-secret-at-least-32-bytes',
        STORAGE_PATH: resolve(import.meta.dirname, '../../../Temp/request-errors'),
      }),
      prisma: prisma as unknown as PrismaClient,
    });
    if (failure) {
      app.get('/request-errors/failure', { schema: { hide: true } }, async () => {
        throw failure;
      });
    }
    apps.push(app);
    return { app, prisma, warn: vi.spyOn(app.log, 'warn'), error: vi.spyOn(app.log, 'error') };
  } catch (cause) {
    throw new Error('请求错误边界测试初始化失败', { cause });
  }
}

/** 关闭测试应用并恢复日志观察器，避免随机顺序执行共享测试状态。 */
afterEach(async () => {
  try {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  } catch (cause) {
    throw new Error('请求错误边界测试清理失败', { cause });
  } finally {
    vi.restoreAllMocks();
  }
});

describe('框架请求解析错误边界', () => {
  it.each([
    {
      name: '非法 JSON',
      headers: { 'content-type': 'application/json' },
      payload: `{"password":"${sensitiveValue}",`,
      frameworkCode: 'FST_ERR_CTP_INVALID_JSON_BODY',
      status: 400,
      code: 'VALIDATION_ERROR',
      message: '请求参数不符合接口要求',
    },
    {
      name: '空 JSON 正文',
      headers: { 'content-type': 'application/json' },
      payload: '',
      frameworkCode: 'FST_ERR_CTP_EMPTY_JSON_BODY',
      status: 400,
      code: 'VALIDATION_ERROR',
      message: '请求参数不符合接口要求',
    },
    {
      name: '正文长度与声明不一致',
      headers: { 'content-type': 'application/json', 'content-length': '4' },
      payload: '{}',
      frameworkCode: 'FST_ERR_CTP_INVALID_CONTENT_LENGTH',
      status: 400,
      code: 'VALIDATION_ERROR',
      message: '请求参数不符合接口要求',
    },
    {
      name: '不支持的媒体类型',
      headers: { 'content-type': 'application/octet-stream' },
      payload: sensitiveValue,
      frameworkCode: 'FST_ERR_CTP_INVALID_MEDIA_TYPE',
      status: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: '请求内容格式不受支持',
    },
  ])('$name 保留客户端错误状态，不进入数据库且不回显原始输入', async (scenario) => {
    try {
      const { app, prisma, warn, error } = setup();
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: { ...scenario.headers, 'x-request-id': requestId },
        payload: scenario.payload,
      });
      expect(response.statusCode, response.body).toBe(scenario.status);
      expect(response.json()).toEqual({ code: scenario.code, message: scenario.message, request_id: requestId });
      expect(response.body).not.toContain(sensitiveValue);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith({ code: scenario.frameworkCode, request_id: requestId }, '请求正文解析失败');
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sensitiveValue);
      expect(error).not.toHaveBeenCalled();
    } catch (cause) {
      throw new Error(`${scenario.name} 错误分类验证失败`, { cause });
    }
  });

  it.each([
    { method: 'POST' as const, url: '/api/v1/auth/register', length: 1024 * 1024 + 1, code: 'PAYLOAD_TOO_LARGE' },
    { method: 'PUT' as const, url: '/api/v1/profile/avatar', length: 12 * 1024 * 1024 + 1, code: 'AVATAR_TOO_LARGE' },
  ])('$url 正文超限保持原有 413 语义', async ({ method, url, length, code }) => {
    try {
      const { app, prisma } = setup();
      const response = await app.inject({
        method,
        url,
        headers: { 'content-type': 'application/json', 'content-length': String(length), 'x-request-id': requestId },
        payload: '{}',
      });
      expect(response.statusCode, response.body).toBe(413);
      expect(response.json()).toMatchObject({ code, request_id: requestId });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    } catch (cause) {
      throw new Error('正文超限错误边界回归失败', { cause });
    }
  });

  it('Schema 校验失败仍返回原有 400 及校验详情，不进入数据库', async () => {
    try {
      const { app, prisma, warn, error } = setup();
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: { 'x-request-id': requestId },
        payload: {},
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'VALIDATION_ERROR',
        request_id: requestId,
        details: expect.any(Array),
      });
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ request_id: requestId }), '请求参数校验失败');
      expect(error).not.toHaveBeenCalled();
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    } catch (cause) {
      throw new Error('Schema 校验错误边界回归失败', { cause });
    }
  });

  it.each(['UNTRUSTED_FAILURE', 'FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_BODY_TOO_LARGE'])(
    '普通异常伪装 statusCode 和 %s 仍返回 500 并完整记录错误',
    async (code) => {
      try {
        const cause = new Error('内部数据库原因');
        const failure = Object.assign(new Error(sensitiveValue, { cause }), { statusCode: 400, code });
        const { app, error } = setup(failure);
        const response = await app.inject({
          method: 'GET',
          url: '/request-errors/failure',
          headers: { 'x-request-id': requestId },
        });
        expect(response.statusCode, response.body).toBe(500);
        expect(response.json()).toEqual({
          code: 'INTERNAL_ERROR',
          message: '服务暂时不可用，请稍后重试',
          request_id: requestId,
        });
        expect(response.body).not.toContain(sensitiveValue);
        expect(response.body).not.toContain(cause.message);
        expect(error).toHaveBeenCalledWith({ err: failure, request_id: requestId }, '未处理的服务端异常');
      } catch (cause) {
        throw new Error('内部异常不得伪装客户端错误验证失败', { cause });
      }
    },
  );

  it('业务 ApiError 保留原有响应与业务日志语义', async () => {
    try {
      const failure = new ApiError(409, 'KNOWN_CONFLICT', '当前内容已变化', { revision: 2 });
      const { app, warn, error } = setup(failure);
      const response = await app.inject({
        method: 'GET',
        url: '/request-errors/failure',
        headers: { 'x-request-id': requestId },
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toEqual({
        code: failure.code,
        message: failure.message,
        details: failure.details,
        request_id: requestId,
      });
      expect(warn).toHaveBeenCalledWith({ err: failure, code: failure.code, request_id: requestId }, '业务请求失败');
      expect(error).not.toHaveBeenCalled();
    } catch (cause) {
      throw new Error('业务错误边界回归失败', { cause });
    }
  });
});
