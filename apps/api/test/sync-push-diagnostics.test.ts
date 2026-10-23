import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';

/** 本组用例只验证校验失败时的诊断日志；校验在鉴权之前结束，数据库不会被访问。 */
const config: ApiConfig = {
  databaseUrl: 'postgresql://sesame:sesame@127.0.0.1:1/sesame_notes',
  jwtSecret: 'test-secret-that-is-at-least-32-bytes-long',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  storagePath: '.test-storage',
  exchangeRateUpstream: 'https://api.frankfurter.dev',
  exchangeRateCacheTtlSeconds: 43_200,
  githubReleaseToken: '',
  port: 8080,
  host: '127.0.0.1',
  corsOrigins: [],
  rateLimitMax: 1000,
  authRateLimitMax: 1000,
  syncRetentionMinCursor: 0,
  trustProxyCidrs: [],
};

/**
 * 建一个关闭日志的应用并接管 warn：logger:false 走 null logger，它的 child() 返回自身，
 * 因此 request.log 与 app.log 是同一个对象，替换 warn 即可断言诊断日志。
 */
function createApp(): { app: ReturnType<typeof buildApp>; warnings: Array<Record<string, unknown>> } {
  const app = buildApp({ logger: false, config });
  const warnings: Array<Record<string, unknown>> = [];
  (app.log as unknown as { warn: (payload: Record<string, unknown>, message?: string) => void }).warn = (payload) => {
    warnings.push(payload);
  };
  return { app, warnings };
}

describe('同步推送校验失败的诊断日志', () => {
  it('移动端周期模板载荷通过协议校验后正常进入鉴权', async () => {
    const { app, warnings } = createApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sync/push',
        payload: {
          device_id: randomUUID(),
          changes: [
            {
              mutation_id: randomUUID(),
              entity_type: 'recurring_transaction',
              entity_id: randomUUID(),
              ledger_id: randomUUID(),
              sync_id: randomUUID(),
              action: 'upsert',
              updated_at: '2026-09-01T08:15:00.000Z',
              payload: {
                tx_type: 'expense',
                amount: '12.5',
                currency_code: 'CNY',
                category_id: null,
                note: null,
                frequency: 'monthly',
                protocol_version: 1,
                time_zone: 'UTC',
                interval: 1,
                day_of_month: 1,
                day_of_week: null,
                month_of_year: null,
                start_date: '2026-08-01T08:15:00.000Z',
                end_date: null,
                last_generated_date: '2026-09-01T08:15:00.000Z',
                enabled: true,
              },
            },
          ],
        },
      });
      expect(response.statusCode).toBe(401);
      expect(warnings.every((entry) => entry.changes === undefined)).toBe(true);
    } catch (error) {
      console.error('移动端周期同步载荷校验失败', error);
      throw error;
    } finally {
      await app.close();
    }
  });

  it('周期规则分页和生成接口要求认证，规则编辑仍使用同步协议', async () => {
    const { app } = createApp();
    try {
      const ledger = randomUUID();
      const listed = await app.inject({ method: 'GET', url: `/api/v1/ledgers/${ledger}/recurring-transactions` });
      const generated = await app.inject({
        method: 'POST',
        url: `/api/v1/ledgers/${ledger}/recurring-transactions/generate-due`,
        payload: { mutation_id: randomUUID(), expected_sync_id: randomUUID(), expected_currency: 'CNY' },
      });
      expect(listed.statusCode).toBe(401);
      expect(generated.statusCode).toBe(401);
    } catch (error) {
      console.error('周期接口注册边界验证失败', error);
      throw error;
    } finally {
      await app.close();
    }
  });

  it('记录前几个变更的身份字段，便于定位不合契约的推送', async () => {
    const { app, warnings } = createApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sync/push',
        payload: {
          device_id: 'not-a-uuid',
          changes: [
            { mutation_id: 'm-1', entity_type: 'transaction', entity_id: '', ledger_id: '' },
            { mutation_id: 'm-2', entity_type: 'ledger', entity_id: 'not-a-uuid', ledger_id: 'not-a-uuid' },
          ],
        },
      });

      expect(response.statusCode).toBe(400);
      const logged = warnings.find((entry) => Array.isArray(entry.changes));
      expect(logged?.changes).toEqual([
        {
          entity_type: 'transaction',
          entity_id: '',
          mutation_id: 'm-1',
          ledger_id: '',
        },
        {
          entity_type: 'ledger',
          entity_id: 'not-a-uuid',
          mutation_id: 'm-2',
          ledger_id: 'not-a-uuid',
        },
      ]);
    } finally {
      await app.close();
    }
  });

  it('其它路由的校验失败不带变更身份字段', async () => {
    const { app, warnings } = createApp();
    try {
      const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: {} });

      expect(response.statusCode).toBe(400);
      expect(warnings.every((entry) => entry.changes === undefined)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
