import type { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeUpstreamRates } from '../src/modules/accounting/testing.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const apps: ReturnType<typeof buildApp>[] = [];
const identity = '11111111-1111-4111-8111-111111111111';
const upstream = { amount: 1, base: 'USD', date: '2026-10-12', rates: { CNY: 7.1, JPY: '150.25' } };

/** 通过真实认证与 HTTP 错误边界检查代理，仅替换外部汇率和会话存储。 */
async function setup() {
  try {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://unused:unused@localhost:1/unused',
      JWT_SECRET: 'exchange-rate-test-secret-at-least-32-bytes',
      STORAGE_PATH: resolve(import.meta.dirname, '../../../Temp/rate-proxy'),
    });
    const prisma = {
      serverEpoch: { findUniqueOrThrow: vi.fn().mockResolvedValue({ authGeneration: identity }) },
      device: { findFirst: vi.fn().mockResolvedValue({ id: identity }) },
      $disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const app = buildApp({ logger: false, config, prisma: prisma as unknown as PrismaClient });
    apps.push(app);
    const token = await new SignJWT({
      device_id: identity,
      auth_generation: identity,
      credential_version: 0,
      scopes: ['sync:read'],
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(identity)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(config.jwtSecret));
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    return {
      app,
      fetch,
      headers: { authorization: `Bearer ${token}` },
      error: vi.spyOn(app.log, 'error'),
      warn: vi.spyOn(app.log, 'warn'),
    };
  } catch (cause) {
    throw new Error('汇率代理测试初始化失败', { cause });
  }
}

/** 关闭应用并恢复全局网络函数，避免随机测试顺序共享代理缓存或替身。 */
afterEach(async () => {
  try {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  } catch (cause) {
    throw new Error('汇率代理测试清理失败', { cause });
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

describe('自动汇率代理', () => {
  it('同币种并发缺失只请求一次上游，失败后全部调用者可在下一轮重试', async () => {
    const { app, headers, fetch } = await setup();
    await app.ready();
    const pending = Promise.withResolvers<Response>();
    fetch.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(Response.json(upstream));
    const first = Promise.all(
      Array.from({ length: 8 }, () => app.inject({ method: 'GET', url: '/api/v1/exchange-rates?base=USD', headers })),
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    pending.reject(new Error('upstream temporarily offline'));
    const failed = await first;
    expect(failed.every((response) => response.statusCode === 503)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const retried = await app.inject({ method: 'GET', url: '/api/v1/exchange-rates?base=USD', headers });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('把上游数字统一为规范 Decimal 字符串并固定方向', () => {
    expect(normalizeUpstreamRates('USD', { CNY: 7.1, JPY: '150.250000' })).toEqual({
      USD: '1',
      CNY: '7.1',
      JPY: '150.25',
    });
  });

  it('拒绝零或负汇率', () => {
    expect(() => normalizeUpstreamRates('USD', { CNY: 0 })).toThrow('INVALID_UPSTREAM_RATE');
  });

  it.each([{}, { USD: 1 }, { USD: 2, CNY: 7.1 }, { cny: 7.1, CNY: 8 }])(
    '拒绝空报价、非恒等本币报价或重复币种，不能用默认本币制造成功：%j',
    (rates) => {
      expect(() => normalizeUpstreamRates('USD', rates)).toThrow();
    },
  );

  it('有效报价才进入缓存，响应保持 base 到 quote 方向和报价日期', async () => {
    const { app, headers, fetch } = await setup();
    fetch.mockResolvedValueOnce(Response.json(upstream));
    const response = await app.inject({ method: 'GET', url: '/api/v1/exchange-rates?base=USD', headers });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      base_currency: 'USD',
      rate_date: '2026-10-12',
      rates: { USD: '1', CNY: '7.1', JPY: '150.25' },
    });
    expect(new URL(String(fetch.mock.calls[0]![0])).searchParams.get('base')).toBe('USD');
    const cached = await app.inject({ method: 'GET', url: '/api/v1/exchange-rates?base=USD', headers });
    expect(cached.json()).toEqual(response.json());
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['缺少报价', { ...upstream, rates: {} }],
    ['只有本币', { ...upstream, rates: { USD: 1 } }],
    ['基准币种不一致', { ...upstream, base: 'EUR' }],
    ['缺少基准币种', { amount: 1, date: upstream.date, rates: upstream.rates }],
    ['报价数量不是一个本币', { ...upstream, amount: 10 }],
    ['非法日期', { ...upstream, date: '2026-02-30' }],
    ['损坏日期', { ...upstream, date: 20261012 }],
    ['非法汇率', { ...upstream, rates: { CNY: 0 } }],
  ])('%s 明确失败且不污染后续请求缓存', async (_name, payload) => {
    const { app, headers, fetch } = await setup();
    fetch.mockResolvedValueOnce(Response.json(payload)).mockResolvedValueOnce(Response.json(upstream));
    const failed = await app.inject({ method: 'GET', url: '/api/v1/exchange-rates?base=USD', headers });
    expect(failed.statusCode, failed.body).toBe(503);
    expect(failed.json()).toMatchObject({ code: 'EXCHANGE_RATE_UPSTREAM_INVALID' });
    expect(failed.json()).not.toHaveProperty('rates');
    const retried = await app.inject({ method: 'GET', url: '/api/v1/exchange-rates?base=USD', headers });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json().rates.CNY).toBe('7.1');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, null])('协议允许报价日期缺失（%s），不伪造日期', async (date) => {
    const { app, headers, fetch } = await setup();
    fetch.mockResolvedValueOnce(Response.json({ ...upstream, date }));
    const response = await app.inject({ method: 'GET', url: '/api/v1/exchange-rates?base=USD', headers });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().rate_date).toBeNull();
  });

  it('网络故障保留原因并由 HTTP 边界记录一次，调用方收到可重试失败', async () => {
    const { app, headers, fetch, error, warn } = await setup();
    const cause = new Error('UPSTREAM_CONNECTION_RESET');
    fetch.mockRejectedValueOnce(cause);
    const response = await app.inject({ method: 'GET', url: '/api/v1/exchange-rates?base=USD', headers });
    expect(response.statusCode, response.body).toBe(503);
    expect(response.json()).toMatchObject({ code: 'EXCHANGE_RATE_UPSTREAM_FAILED' });
    expect(response.body).not.toContain(cause.message);
    expect(error).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
    expect(error.mock.calls[0]![0]).toMatchObject({ err: { cause } });
  });
});
