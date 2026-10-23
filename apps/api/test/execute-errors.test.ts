import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, registerErrorHandler } from '../src/shared/errors.js';
import { execute, executor } from '../src/shared/execute.js';
import { serializeAdminError } from '../src/shared/request-logging.js';

const apps: FastifyInstance[] = [];
const requestId = 'execute-error-boundary';

/** 将真实执行器接入 HTTP 错误边界，记录最终日志与框架捕获的异常。 */
function setup(operation: () => Promise<unknown>, admin = false, failureCode?: string) {
  try {
    const records: string[] = [];
    const failures: Error[] = [];
    const app = Fastify({
      logger: {
        stream: { write: (record) => records.push(record) },
        ...(admin ? { serializers: { err: serializeAdminError, original_error: serializeAdminError } } : {}),
      },
      requestIdHeader: 'x-request-id',
    });
    registerErrorHandler(app);
    app.addHook('onError', async (_request, _reply, error) => {
      failures.push(error);
    });
    const run = failureCode ? executor(failureCode) : execute;
    app.get('/execute', async (request) => run(request, '保存记录', operation));
    apps.push(app);
    return { app, records, failures };
  } catch (cause) {
    throw new Error('执行器错误边界测试初始化失败', { cause });
  }
}

/** 关闭所有 HTTP 测试实例，保证随机顺序执行时日志互不影响。 */
afterEach(async () => {
  try {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  } catch (cause) {
    throw new Error('执行器错误边界测试资源释放失败', { cause });
  }
});

/** 读取实际写出的告警和错误日志，排除正常访问日志。 */
function errorRecords(records: string[]): Array<Record<string, unknown>> {
  try {
    return records.map((record) => JSON.parse(record)).filter((record) => record.level >= 40);
  } catch (cause) {
    throw new Error('执行器日志解析失败', { cause });
  }
}

describe('路由执行器与统一错误边界', () => {
  it('正常操作只执行一次，真实结果不被替换或产生错误日志', async () => {
    try {
      const result = { id: 'saved-record', revision: 2 };
      const operation = vi.fn().mockResolvedValue(result);
      const { app, records, failures } = setup(operation);
      const response = await app.inject({ url: '/execute' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(result);
      expect(operation).toHaveBeenCalledTimes(1);
      expect(errorRecords(records)).toEqual([]);
      expect(failures).toEqual([]);
    } catch (cause) {
      throw new Error('正常操作结果验证失败', { cause });
    }
  });

  it('业务冲突保留错误对象和详情，统一边界只记录一次告警', async () => {
    try {
      const conflict = new ApiError(409, 'REVISION_CONFLICT', '内容已变更，请刷新后重试', { current_revision: 3 });
      const { app, records, failures } = setup(vi.fn().mockRejectedValue(conflict));
      const response = await app.inject({ url: '/execute', headers: { 'x-request-id': requestId } });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        code: conflict.code,
        message: conflict.message,
        details: conflict.details,
        request_id: requestId,
      });
      expect(failures).toEqual([conflict]);
      expect(errorRecords(records)).toEqual([
        expect.objectContaining({ level: 40, action: '保存记录', code: conflict.code, request_id: requestId }),
      ]);
    } catch (cause) {
      throw new Error('业务冲突单次日志验证失败', { cause });
    }
  });

  it.each([undefined, 'AVATAR_OPERATION_FAILED'])(
    '内部故障保留原始原因与 %s 失败码，不能返回成功',
    async (failureCode) => {
      try {
        const databaseError = Object.assign(new Error('数据库写入失败：private-database-detail'), { code: 'P2002' });
        const { app, records, failures } = setup(vi.fn().mockRejectedValue(databaseError), false, failureCode);
        const response = await app.inject({ url: '/execute', headers: { 'x-request-id': requestId } });
        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({
          code: failureCode ?? 'DATABASE_OPERATION_FAILED',
          message: '保存记录失败，请稍后重试',
          request_id: requestId,
        });
        expect(failures).toHaveLength(1);
        expect(failures[0]).toBeInstanceOf(ApiError);
        expect(failures[0]?.cause).toBe(databaseError);
        expect(response.body).not.toContain('private-database-detail');
        const logs = errorRecords(records);
        expect(logs).toEqual([expect.objectContaining({ level: 50, action: '保存记录', request_id: requestId })]);
        expect(JSON.stringify(logs)).toContain('private-database-detail');
        expect(JSON.stringify(logs)).toContain('execute-errors.test.ts');
      } catch (cause) {
        throw new Error('内部故障转换与诊断上下文验证失败', { cause });
      }
    },
  );

  it('已有服务不可用错误保持原错误码，统一边界按故障记录一次', async () => {
    try {
      const failure = new ApiError(503, 'DEPENDENCY_UNAVAILABLE', '依赖服务暂不可用');
      const { app, records, failures } = setup(vi.fn().mockRejectedValue(failure));
      const response = await app.inject({ url: '/execute', headers: { 'x-request-id': requestId } });
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe(failure.code);
      expect(failures).toEqual([failure]);
      expect(errorRecords(records)).toEqual([
        expect.objectContaining({ level: 50, action: '保存记录', code: failure.code, request_id: requestId }),
      ]);
    } catch (cause) {
      throw new Error('服务不可用错误语义验证失败', { cause });
    }
  });

  it('后台脱敏日志保留原始故障代码与源码位置，不记录原始参数', async () => {
    try {
      const failure = Object.assign(new Error('SQL included PRIVATE_PASSWORD'), { code: 'P2002' });
      const { app, records } = setup(vi.fn().mockRejectedValue(failure), true);
      const response = await app.inject({ url: '/execute', headers: { 'x-request-id': requestId } });
      expect(response.statusCode).toBe(500);
      const logs = errorRecords(records);
      expect(logs).toEqual([
        expect.objectContaining({
          level: 50,
          original_error: expect.objectContaining({
            code: 'P2002',
            stack: expect.stringContaining('execute-errors.test.ts'),
          }),
        }),
      ]);
      expect(records.join('\n')).not.toContain('PRIVATE_PASSWORD');
      expect(response.body).not.toContain('PRIVATE_PASSWORD');
    } catch (cause) {
      throw new Error('后台原始原因脱敏验证失败', { cause });
    }
  });
});
