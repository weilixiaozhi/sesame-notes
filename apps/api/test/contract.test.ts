import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';

import { buildApp } from '../src/app.js';
import { loadTestApiConfig } from './test-api-config.js';
import { ANY_UUID_PATTERN } from '../src/shared/contracts/scalars.js';
import { TransactionSplitSchema } from '../src/shared/contracts/accounting.js';

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  try {
    app = buildApp({ logger: false, config: loadTestApiConfig() });
    await app.ready();
  } catch (cause) {
    throw new Error('OpenAPI 契约测试服务初始化失败', { cause });
  }
});

afterAll(async () => {
  try {
    // 构建失败时没有服务实例；已创建的实例统一在清理阶段关闭。
    if (app) await app.close();
  } catch (cause) {
    throw new Error('OpenAPI 契约测试服务关闭失败', { cause });
  }
});

/** 校验统一错误模型：要么引用 Error schema，要么是含 code/message/request_id 的对象 （允许带 details 的业务扩展，如导入校验明细）。 */
function expectUnifiedError(
  schema: { $ref?: string; type?: string; properties?: Record<string, unknown> } | undefined,
): void {
  if (schema?.$ref) {
    expect(schema.$ref).toBe('#/components/schemas/Error');
    return;
  }
  expect(schema?.type).toBe('object');
  expect(Object.keys(schema?.properties ?? {})).toEqual(expect.arrayContaining(['code', 'message', 'request_id']));
}

describe('Sesame Notes v1 客户端契约', () => {
  it('分摊响应必须含有效成员 ID，兼容 UUID v4/v5 并拒绝空引用', () => {
    for (const memberId of ['10000000-0000-4000-8000-000000000001', '056cf10d-2d59-599c-9d97-6749e866aa52']) {
      expect(Value.Check(TransactionSplitSchema, { member_id: memberId, amount: '10' })).toBe(true);
    }
    for (const memberId of [undefined, null, '', 'invalid']) {
      expect(Value.Check(TransactionSplitSchema, { member_id: memberId, amount: '10' })).toBe(false);
    }
    const document = app.swagger() as ReturnType<typeof app.swagger> & {
      components?: { schemas?: Record<string, unknown> };
    };
    const split = document.components?.schemas?.TransactionSplit;
    expect(split).toMatchObject({
      required: ['member_id', 'amount'],
      properties: { member_id: { type: 'string', pattern: ANY_UUID_PATTERN } },
    });
    expect(JSON.stringify(split)).not.toContain('"nullable":true');
    expect(JSON.stringify(split)).not.toContain('"type":"null"');
  });

  it('金额字段使用十进制字符串，避免 JSON 浮点精度损失', () => {
    const document = app.swagger() as ReturnType<typeof app.swagger> & {
      components?: { schemas?: Record<string, unknown> };
    };
    const transaction = document.components?.schemas?.Transaction;
    expect(transaction).toMatchObject({
      properties: {
        amount: { type: 'string', pattern: expect.any(String) },
        native_amount: { type: 'string', pattern: expect.any(String) },
        // revision 为服务端权威乐观并发版本：整数且最小为 1
        revision: { type: 'integer', minimum: 1 },
        last_edited_at: expect.any(Object),
      },
    });
  });

  it('OpenAPI 明确区分 Bearer 鉴权接口与公开认证接口', () => {
    const document = app.swagger() as {
      components?: { securitySchemes?: Record<string, unknown> };
      paths?: Record<string, { get?: { security?: unknown }; post?: { security?: unknown } }>;
    };

    expect(document.components?.securitySchemes).toMatchObject({
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    });
    expect(document.paths?.['/api/v1/profile/me']?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths?.['/api/v1/auth/login']?.post?.security).toEqual([]);
    expect(document.paths?.['/api/v1/fitness/library']?.get?.security).toEqual([]);
  });

  it('每个公开操作都有唯一 operationId 和统一错误模型', () => {
    const operationIds: string[] = [];

    for (const [path, item] of Object.entries(app.swagger().paths ?? {})) {
      for (const [method, rawOperation] of Object.entries(item ?? {})) {
        const operation = rawOperation as {
          operationId?: string;
          responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
        };
        expect(operation.operationId, `${method.toUpperCase()} ${path} 缺少 operationId`).toMatch(
          /^[a-z][A-Za-z0-9]+$/,
        );
        operationIds.push(operation.operationId!);
        expectUnifiedError(operation.responses?.['400']?.content?.['application/json']?.schema);
        expectUnifiedError(operation.responses?.['500']?.content?.['application/json']?.schema);
      }
    }
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });
});
