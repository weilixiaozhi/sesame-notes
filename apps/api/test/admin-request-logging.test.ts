import type { PrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { serializeAdminError } from '../src/shared/request-logging.js';

describe('后台访问日志隐私边界', () => {
  const records: string[] = [];
  let loggerApp: FastifyInstance;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    try {
      loggerApp = Fastify({ logger: { stream: { write: (record) => records.push(record) } } });
      app = buildApp({
        logger: loggerApp.log,
        config: loadConfig({
          DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
          JWT_SECRET: 'admin-request-logging-test-at-least-32-bytes',
          STORAGE_PATH: 'Temp/admin-request-logging',
          ADMIN_ORIGINS: 'https://admin.example',
        }),
        prisma: {
          adminAccount: {
            findUnique: vi.fn().mockRejectedValue(new Error('Lookup failed: private-email@example.com')),
          },
          $disconnect: vi.fn().mockResolvedValue(undefined),
        } as unknown as PrismaClient,
      });
      // 完整路由与 Schema 编译属于夹具准备，实际请求的隐私验证在准备完成后执行。
      await app.ready();
    } catch (cause) {
      throw new Error('后台日志隐私测试初始化失败', { cause });
    }
  });

  afterAll(async () => {
    try {
      await app?.close();
      await loggerApp?.close();
    } catch (cause) {
      throw new Error('后台日志隐私测试资源释放失败', { cause });
    }
  });

  it('真实登录校验和用户搜索日志不记录手机号、密码或Cookie', async () => {
    try {
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        headers: { origin: 'https://admin.example', 'x-admin-request': '1', cookie: 'private_cookie=SENSITIVE_COOKIE' },
        payload: { username: { value: 'SENSITIVE_PROFILE' }, password: 'SENSITIVE_PASSWORD' },
      });
      expect(login.statusCode).toBe(400);
      const search = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/users?page=1&page_size=10&search=%2B8613800123456',
      });
      expect(search.statusCode).toBe(401);
      const unavailable = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        headers: { origin: 'https://admin.example', 'x-admin-request': '1' },
        payload: { username: 'private-email@example.com', password: 'SENSITIVE_PASSWORD' },
      });
      expect(unavailable.statusCode).toBe(503);
      const output = records.join('\n');
      expect(output).toContain('/api/v1/admin');
      expect(output).toContain('请求参数校验失败');
      for (const secret of [
        'SENSITIVE_PASSWORD',
        'SENSITIVE_COOKIE',
        'SENSITIVE_PROFILE',
        '13800123456',
        'private-email@example.com',
      ]) {
        expect(output).not.toContain(secret);
      }
    } catch (cause) {
      throw new Error('后台请求日志隐私验证失败', { cause });
    }
  });

  it('数据库异常仅保留错误类型、代码和源码位置', () => {
    const error = Object.assign(new Error('SQL included SENSITIVE_PASSWORD'), {
      code: 'P2002',
      meta: { phone: '13800123456' },
    });
    const record = serializeAdminError(error);
    expect(record.type).toBe('Error');
    expect(record.code).toBe('P2002');
    expect(record.stack).toContain('admin-request-logging.test.ts');
    expect(JSON.stringify(record)).not.toContain('SENSITIVE_PASSWORD');
    expect(JSON.stringify(record)).not.toContain('13800123456');
  });

  it('编码后的后台路径仍启用异常脱敏和禁止缓存', async () => {
    try {
      records.length = 0;
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/%61dmin/auth/login',
        headers: { origin: 'https://admin.example', 'x-admin-request': '1' },
        payload: { username: 'private-email@example.com', password: 'SENSITIVE_PASSWORD' },
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(records.join('\n')).not.toContain('private-email@example.com');
      expect(records.join('\n')).not.toContain('SENSITIVE_PASSWORD');
    } catch (cause) {
      throw new Error('后台编码路径的隐私边界验证失败', { cause });
    }
  });

  it.each(['/api/v1/admin/not-found', '/api/v1/%61dmin/not-found'])(
    '未知后台路径不把查询复制进日志或错误正文：%s',
    async (path) => {
      try {
        records.length = 0;
        const response = await app.inject({ url: `${path}?search=PRIVATE_SEARCH_VALUE` });
        expect(response.statusCode).toBe(404);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.json()).toMatchObject({ code: 'NOT_FOUND', message: '请求的内容不存在' });
        expect(response.body).not.toContain('PRIVATE_SEARCH_VALUE');
        expect(records.join('\n')).not.toContain('PRIVATE_SEARCH_VALUE');
      } catch (cause) {
        throw new Error('后台未知路由的隐私边界验证失败', { cause });
      }
    },
  );
});
