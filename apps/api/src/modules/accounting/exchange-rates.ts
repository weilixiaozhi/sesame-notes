import { Prisma, type PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

import type { ApiConfig } from '../../shared/api-config.js';
import { ApiError } from '../../shared/errors.js';
import { CurrencySchema, RATE_PATTERN } from '../../shared/contracts/scalars.js';
import { ExchangeRateOverrideSchema } from '../../shared/contracts/accounting.js';
import { execute } from '../../shared/execute.js';
import { decimalToCanonical } from '../../shared/decimal.js';
import { authenticate, requireAuth, requireScopes } from '../auth/index.js';

type RateResult = {
  base_currency: string;
  rate_date: string | null;
  source: string;
  fetched_at: string;
  rates: Record<string, string>;
};

/** 注册自动汇率代理；短时内存缓存足以避免移动端重复刷新击穿公开上游。 */
export function registerExchangeRateRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  // 缓存与进行中请求按币种在当前 API 实例内共享。
  const cache = new Map<string, { expiresAt: number; value: RateResult }>();
  const inFlight = new Map<string, Promise<RateResult>>();
  app.get(
    '/api/v1/exchange-rate-overrides',
    {
      preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')],
      schema: {
        tags: ['accounting'],
        querystring: Type.Object({ base: Type.Optional(CurrencySchema) }),
        response: { 200: Type.Array(Type.Ref(ExchangeRateOverrideSchema)) },
      },
    },
    async (request) =>
      execute(request, '读取个人汇率覆盖', async () => {
        const { userId } = requireAuth(request);
        const query = request.query as { base?: string };
        const rows = await prisma.exchangeRateOverride.findMany({
          where: { ownerId: userId, deletedAt: null, ...(query.base ? { baseCurrency: query.base } : {}) },
          orderBy: [{ baseCurrency: 'asc' }, { quoteCurrency: 'asc' }],
        });
        return rows.map((row) => ({
          id: row.id,
          base_currency: row.baseCurrency,
          quote_currency: row.quoteCurrency,
          rate: decimalToCanonical(row.rate, 18),
          updated_at: row.updatedAt.toISOString(),
        }));
      }),
  );

  app.get(
    '/api/v1/exchange-rates',
    {
      preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')],
      schema: {
        tags: ['exchange-rates'],
        querystring: Type.Object({ base: CurrencySchema }),
        response: {
          200: Type.Object({
            base_currency: CurrencySchema,
            rate_date: Type.Union([Type.String({ format: 'date' }), Type.Null()]),
            source: Type.String(),
            fetched_at: Type.String({ format: 'date-time' }),
            rates: Type.Record(CurrencySchema, Type.String({ pattern: RATE_PATTERN })),
          }),
        },
      },
    },
    async (request) =>
      execute(request, '读取自动汇率', async () => {
        requireAuth(request);
        const base = (request.query as { base: string }).base;
        const cached = cache.get(base);
        if (cached && cached.expiresAt > Date.now()) return cached.value;
        const active = inFlight.get(base);
        if (active) return active;
        /** 同币种共享一次上游读取，校验通过后才写入成功缓存。 */
        const refresh = (async () => {
          const url = new URL('/v1/latest', `${config.exchangeRateUpstream.replace(/\/+$/, '')}/`);
          url.searchParams.set('base', base);
          let payload: unknown;
          try {
            const response = await fetch(url, {
              headers: { accept: 'application/json' },
              signal: AbortSignal.timeout(8_000),
            });
            if (!response.ok) throw new Error(`汇率上游 HTTP 状态异常：${response.status}`);
            payload = await response.json();
          } catch (cause) {
            throw new ApiError(503, 'EXCHANGE_RATE_UPSTREAM_FAILED', '自动汇率服务暂时不可用', undefined, { cause });
          }
          // 基准、报价数量和内容在上游边界一次确认，只有可用于折算的结果才能进入成功缓存。
          const value: RateResult = {
            base_currency: base,
            ...normalizeUpstreamPayload(base, payload),
            source: url.hostname,
            fetched_at: new Date().toISOString(),
          };
          cache.set(base, { expiresAt: Date.now() + config.exchangeRateCacheTtlSeconds * 1_000, value });
          return value;
        })();
        inFlight.set(base, refresh);
        try {
          return await refresh;
        } finally {
          // 失败 Promise 不能留在缓存中，下一轮请求应能真正重试上游。
          if (inFlight.get(base) === refresh) inFlight.delete(base);
        }
      }),
  );
}

/** 把上游汇率转为协议规定的正数 Decimal 字符串，方向保持为 1 base = rate quote。 */
export function normalizeUpstreamRates(base: string, rates: Record<string, unknown>): Record<string, string> {
  try {
    const normalized: Record<string, string> = {};
    for (const [rawCurrency, rawRate] of Object.entries(rates)) {
      const currency = rawCurrency.toUpperCase();
      if (
        !/^[A-Z]{3}$/.test(currency) ||
        Object.hasOwn(normalized, currency) ||
        (typeof rawRate !== 'string' && typeof rawRate !== 'number')
      )
        throw new Error('INVALID_UPSTREAM_RATE');
      const decimal = new Prisma.Decimal(rawRate);
      if (!decimal.isFinite() || !decimal.isPositive()) throw new Error('INVALID_UPSTREAM_RATE');
      // 同币种的恒等汇率是业务事实，上游不能用另一数值改变其含义。
      if (currency === base && !decimal.equals(1)) throw new Error('INVALID_UPSTREAM_RATE');
      const value = decimalToCanonical(decimal, 18);
      if (!new RegExp(RATE_PATTERN).test(value)) throw new Error('INVALID_UPSTREAM_RATE');
      normalized[currency] = value;
    }
    if (!Object.keys(normalized).some((currency) => currency !== base)) throw new Error('INVALID_UPSTREAM_RATE');
    normalized[base] = '1';
    return normalized;
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_UPSTREAM_RATE') throw error;
    throw new Error('INVALID_UPSTREAM_RATE', { cause: error });
  }
}

/** 将不可信的上游报价转换为固定单位与方向，合法缺失日期仍保留明确空值。 */
function normalizeUpstreamPayload(base: string, payload: unknown): Pick<RateResult, 'rate_date' | 'rates'> {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('上游报价结构无效');
    const { amount, base: upstreamBase, date, rates } = payload as Record<string, unknown>;
    if (upstreamBase !== base || amount !== 1) throw new Error('上游报价基准或单位与请求不一致');
    if (!rates || typeof rates !== 'object' || Array.isArray(rates)) throw new Error('上游报价列表无效');
    let rateDate: string | null = null;
    if (date !== undefined && date !== null) {
      if (
        typeof date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        date.startsWith('0000') ||
        new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date
      )
        throw new Error('上游报价日期无效');
      rateDate = date;
    }
    return { rate_date: rateDate, rates: normalizeUpstreamRates(base, rates as Record<string, unknown>) };
  } catch (cause) {
    throw new ApiError(503, 'EXCHANGE_RATE_UPSTREAM_INVALID', '自动汇率服务返回了无效数据', undefined, { cause });
  }
}
