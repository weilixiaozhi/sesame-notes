import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';

import { buildApp } from '../src/app.js';
import { loadTestApiConfig } from './test-api-config.js';
import { ANY_UUID_PATTERN } from '../src/shared/contracts/scalars.js';
import {
  CategorySchema,
  RecurringTransactionSchema,
  TransactionSchema,
  TransactionSplitSchema,
} from '../src/shared/contracts/accounting.js';

const apps: Array<ReturnType<typeof buildApp>> = [];
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

/** 为 HTTP 请求检查创建独立服务，避免认证与限流状态互相影响。 */
function createTestApp(): ReturnType<typeof buildApp> {
  try {
    const app = buildApp({ logger: false, config: loadTestApiConfig() });
    apps.push(app);
    return app;
  } catch (cause) {
    throw new Error('OpenAPI 契约请求测试服务构建失败', { cause });
  }
}

/** 关闭测试服务，防止资源泄漏污染其他用例。 */
async function closeTestApps(): Promise<void> {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
}

afterEach(closeTestApps);

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

  it('同步恢复、载荷限制与头像格式完整描述真实响应', () => {
    const paths = app.swagger().paths!;
    expect(paths['/api/v1/sync/pull']!.get!.responses).toHaveProperty('410');
    expect(paths['/api/v1/sync/push']!.post!.responses).toHaveProperty('412');
    expect(paths['/api/v1/sync/push']!.post!.responses).toHaveProperty('413');
    const upload = paths['/api/v1/profile/avatar']!.put!.responses!;
    expect(upload).toHaveProperty('413');
    expect(upload).toHaveProperty('422');
    const download = paths['/api/v1/profile/avatar/{user_id}']!.get!.responses!['200'];
    expect(download).toMatchObject({ content: { 'image/webp': { schema: { type: 'string', format: 'binary' } } } });
    expect(paths['/api/v1/sync/pull']!.get!.responses!['429']).toMatchObject({
      headers: { 'Retry-After': { schema: { type: 'string' } } },
    });
  });

  it.each([
    ['交易', TransactionSchema.properties.tx_type],
    ['分类', CategorySchema.properties.kind],
    ['周期账单', RecurringTransactionSchema.properties.tx_type],
  ])('%s 类型只接受支出', (_label, schema) => {
    expect(Value.Check(schema, 'expense')).toBe(true);
    expect(Value.Check(schema, 'income')).toBe(false);
    expect(Value.Check(schema, 'transfer')).toBe(false);
  });

  it('公开契约只保留支出设置和统计字段', () => {
    const document = JSON.stringify(app.swagger());
    expect(document).not.toContain('"income_is_red"');
    expect(document).not.toContain('"income_total"');
    expect(document).toContain('"expense_total"');
  });

  it('不发布 Personal Access Token 接口', () => {
    const paths = app.swagger().paths;
    expect(paths).not.toHaveProperty('/api/v1/pat');
    expect(paths).not.toHaveProperty('/api/v1/pat/{pat_id}');
    expect(paths).not.toHaveProperty('/api/v1/admin/users/{user_id}/pats/{pat_id}');
  });

  it('非 JWT 的 Bearer 凭证一律拒绝', async () => {
    const app = createTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/ledgers',
      headers: { authorization: 'Bearer sesame_pat_legacy' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('发布认证、核心记账和同步接口', () => {
    const paths = app.swagger().paths;
    expect(paths).toMatchObject({
      '/api/v1/auth/register': { post: expect.any(Object) },
      '/api/v1/auth/login': { post: expect.any(Object) },
      '/api/v1/auth/refresh': { post: expect.any(Object) },
      '/api/v1/profile/me': {
        get: expect.any(Object),
        patch: expect.any(Object),
      },
      '/api/v1/profile/avatar': {
        put: expect.any(Object),
        delete: expect.any(Object),
      },
      '/api/v1/profile/avatar/{user_id}': { get: expect.any(Object) },
      '/api/v1/exchange-rates': { get: expect.any(Object) },
      '/api/v1/ledgers': {
        get: expect.any(Object),
        post: expect.any(Object),
      },
      '/api/v1/ledgers/{ledger_id}/transactions': {
        get: expect.any(Object),
        post: expect.any(Object),
      },
      '/api/v1/ledgers/{ledger_id}/categories': {
        get: expect.any(Object),
        post: expect.any(Object),
      },
      '/api/v1/ledgers/{ledger_id}/members': { get: expect.any(Object) },
      '/api/v1/ledgers/{ledger_id}/member-stats': { get: expect.any(Object) },
      '/api/v1/ledgers/{ledger_id}/shared-resources': { get: expect.any(Object) },
      '/api/v1/ledgers/{ledger_id}/invites': {
        post: expect.any(Object),
      },
      '/api/v1/invites/{code}/accept': { post: expect.any(Object) },
      '/api/v1/ws/ticket': { post: expect.any(Object) },
      '/api/v1/sync/push': { post: expect.any(Object) },
      '/api/v1/sync/pull': { get: expect.any(Object) },
      '/api/v1/sync/full': { get: expect.any(Object) },
      '/api/v1/fitness/library': { get: expect.any(Object) },
    });
  });

  it('实体 id 只要求合法 UUID，只有需要跨设备复算的实体锁定确定性 v5', () => {
    const document = app.swagger() as ReturnType<typeof app.swagger> & {
      components?: { schemas?: Record<string, { properties?: Record<string, { pattern?: string }> }> };
    };
    const transactionIdPattern = document.components?.schemas?.Transaction?.properties?.id?.pattern;
    const ledgerIdPattern = document.components?.schemas?.Ledger?.properties?.id?.pattern;
    const rateIdPattern = document.components?.schemas?.ExchangeRateOverride?.properties?.id?.pattern;

    // 离线实体 id 由客户端生成：随机 v4 是惯例，CSV 导入等幂等场景用确定性 v5，
    // 服务端对版本没有任何依赖，契约只校验形状（收紧到 v4 会让合法数据整批 400）。
    expect(transactionIdPattern).toBe(ANY_UUID_PATTERN);
    expect(ledgerIdPattern).toBe(transactionIdPattern);
    // 汇率覆盖是唯一要求共享算法派生的实体：同账号同币对必须收敛到同一 id。
    expect(rateIdPattern).toContain('-5');
  });

  it('aa_mode 使用字符串枚举，保持 Dart 生成客户端可反序列化', () => {
    const document = app.swagger() as ReturnType<typeof app.swagger> & {
      components?: {
        schemas?: Record<
          string,
          { properties?: Record<string, { anyOf?: Array<{ type?: string; enum?: unknown[] }> }> }
        >;
      };
    };
    const aaMode = document.components?.schemas?.Transaction?.properties?.aa_mode;
    const variants = aaMode?.anyOf;
    expect(variants).toBeDefined();
    // 数值枚举生成的 Dart 枚举只认字符串 wire 名，服务端契约必须直接收敛为字符串
    expect(variants).toHaveLength(4);
    expect(variants!.map((variant) => variant.enum?.[0] ?? null)).toEqual(['0', '1', '2', null]);
    for (const variant of variants!) {
      if (variant.enum) expect(variant.type).toBe('string');
    }
  });

  it('交易契约使用关系化 splits，完全移除旧 JSON 分摊字段', () => {
    const document = app.swagger() as ReturnType<typeof app.swagger> & {
      components?: { schemas?: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
    };
    const transaction = document.components?.schemas?.Transaction;

    expect(transaction?.properties).toHaveProperty('splits');
    expect(transaction?.required).toContain('splits');
    expect(transaction?.properties).not.toHaveProperty('aa_participants');
    expect(transaction?.properties).not.toHaveProperty('aa_splits');
  });

  it('高风险交易写入声明 Idempotency-Key 请求头', () => {
    const operation = (app.swagger().paths ?? {})['/api/v1/ledgers/{ledger_id}/transactions']?.post;
    expect(operation?.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'idempotency-key', in: 'header', required: false })]),
    );
  });

  it('批量导入声明 Idempotency-Key 请求头', () => {
    const operation = (app.swagger().paths ?? {})['/api/v1/ledgers/{ledger_id}/imports']?.post;
    expect(operation?.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'idempotency-key', in: 'header', required: false })]),
    );
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

  it('所有业务错误都包含稳定错误码和 request_id', async () => {
    const app = createTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { country_code: '', phone: '', password: '' },
      headers: { 'x-request-id': 'contract-error-1' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'VALIDATION_ERROR',
      request_id: 'contract-error-1',
    });
  });

  it('每个公开操作都声明可生成客户端的成功响应', () => {
    for (const [path, item] of Object.entries(app.swagger().paths ?? {})) {
      for (const [method, rawOperation] of Object.entries(item ?? {})) {
        const operation = rawOperation as {
          responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
        };
        const responses = operation?.responses ?? {};
        const success = Object.entries(responses).find(([status]) => /^2\d\d$/.test(status));
        expect(success, `${method.toUpperCase()} ${path} 缺少 2xx 响应`).toBeDefined();
        if (success?.[0] !== '204') {
          const content = success?.[1]?.content ?? {};
          // 二进制端点（如头像下载）声明 image/* 原始字节，不要求 JSON schema
          const isBinary = Object.keys(content).some((media) => media.startsWith('image/'));
          if (!isBinary) {
            expect(
              content['application/json']?.schema,
              `${method.toUpperCase()} ${path} 缺少 JSON 响应 Schema`,
            ).toBeDefined();
          }
        }
      }
    }
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
