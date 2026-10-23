import { Prisma, type PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

import type { ApiConfig } from '../../shared/api-config.js';
import { ApiError } from '../../shared/errors.js';
import { executor } from '../../shared/execute.js';
import {
  AmountSchema,
  AnyUuidSchema,
  CurrencySchema,
  TimestampSchema,
  UuidSchema,
} from '../../shared/contracts/scalars.js';
import { decimalToCanonical } from '../../shared/decimal.js';
import { authenticate, requireAuth, requireScopes } from '../auth/index.js';
import { getLedgerReadAccess } from '../accounting/index.js';

/** 成员统计共用的 500 失败码，捕获与日志由公共执行器负责。 */
const executeMemberStats = executor('MEMBER_STATS_FAILED');

const ScopeSchema = Type.Union([Type.Literal('month'), Type.Literal('year'), Type.Literal('all')]);
type AnalyticsScope = 'month' | 'year' | 'all';
type AnalyticsRange = { period: string | null; startAt: Date | null; endAt: Date | null };

/** 注册共享账本成员统计，金额始终以账本本位币 Decimal 字符串返回。 */
export function registerMemberStatsRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  app.get(
    '/api/v1/ledgers/:ledger_id/member-stats',
    {
      preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')],
      schema: {
        tags: ['sharing'],
        params: Type.Object({ ledger_id: AnyUuidSchema }),
        querystring: Type.Object({
          scope: Type.Optional(ScopeSchema),
          dimension: Type.Optional(
            Type.Union([Type.Literal('creator'), Type.Literal('payer')], {
              description:
                'creator按记录人汇总全部未删除支出；payer按付款人汇总全部未删除支出，不含未指定付款人的交易。',
            }),
          ),
          period: Type.Optional(Type.String({ pattern: '^(?:[0-9]{4}|[0-9]{4}-(?:0[1-9]|1[0-2]))$' })),
          tz_offset_minutes: Type.Optional(Type.Integer({ minimum: -720, maximum: 840 })),
        }),
        response: {
          200: Type.Object({
            ledger_id: AnyUuidSchema,
            ledger_currency: CurrencySchema,
            scope: ScopeSchema,
            period: Type.Union([Type.String(), Type.Null()]),
            start_at: Type.Union([TimestampSchema, Type.Null()]),
            end_at: Type.Union([TimestampSchema, Type.Null()]),
            items: Type.Array(
              Type.Object({
                user_id: Type.Union([UuidSchema, Type.Null()]),
                // canonical 成员 id 维度（可选）：历史记录人（无成员行）为 null
                member_id: Type.Optional(Type.Union([AnyUuidSchema, Type.Null()])),
                // 共享协议只暴露芝麻号作为公开编号，不返回 account/手机号/性别
                sesame_number: Type.Union([Type.String(), Type.Null()]),
                display_name: Type.Union([Type.String(), Type.Null()]),
                avatar_url: Type.Union([Type.String(), Type.Null()]),
                avatar_version: Type.Integer({ minimum: 0 }),
                role: Type.Union([
                  Type.Literal('owner'),
                  Type.Literal('editor'),
                  Type.Literal('removed'),
                  Type.Literal('unknown'),
                ]),
                expense_total: AmountSchema,
                tx_count: Type.Integer({ minimum: 0 }),
              }),
            ),
          }),
        },
      },
    },
    async (request) =>
      executeMemberStats(request, '读取成员统计', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId } = request.params as { ledger_id: string };
        const query = request.query as {
          scope?: AnalyticsScope;
          period?: string;
          tz_offset_minutes?: number;
          dimension?: 'creator' | 'payer';
        };
        const byPayer = query.dimension === 'payer';
        const memberColumn = byPayer ? 'payerMemberId' : 'createdByMemberId';
        const { ledger } = await getLedgerReadAccess(prisma, auth.userId, ledgerId, 'editor');
        const scope = query.scope ?? 'month';
        const range = analyticsRange(scope, query.period, query.tz_offset_minutes ?? 0, ledger.monthStartDay);
        const happenedAt =
          range.startAt || range.endAt
            ? { ...(range.startAt ? { gte: range.startAt } : {}), ...(range.endAt ? { lt: range.endAt } : {}) }
            : undefined;
        const [members, rows] = await Promise.all([
          prisma.ledgerMember.findMany({
            where: { ledgerId },
            include: { linkedAccount: { include: { profile: true } } },
          }),
          // 付款汇总与手机成员视图对齐；未选择维度时保留原记录人统计口径。
          prisma.transaction.groupBy({
            by: [memberColumn],
            where: {
              ledgerId,
              deletedAt: null,
              ...(byPayer ? { payerMemberId: { not: null } } : {}),
              txType: 'expense',
              ...(happenedAt ? { happenedAt } : {}),
            },
            _sum: { nativeAmount: true },
            _count: { _all: true },
          }),
        ]);

        const totals = new Map(
          rows.map((row) => [
            row[memberColumn],
            {
              expense: row._sum.nativeAmount ?? new Prisma.Decimal(0),
              count: row._count._all,
            },
          ]),
        );

        const memberById = new Map(members.map((member) => [member.id, member]));
        const memberIds = new Set<string | null>(byPayer ? totals.keys() : [...memberById.keys(), ...totals.keys()]);
        const items = [...memberIds].map((memberId) => {
          const member = memberId ? memberById.get(memberId) : undefined;
          const value = totals.get(memberId) ?? {
            expense: new Prisma.Decimal(0),
            count: 0,
          };
          const active = Boolean(member);
          // 绑定账号可能为空（PLACEHOLDER 成员）：展示名回退成员快照
          const user = member?.linkedAccount;
          const userId = member?.linkedAccountId ?? null;
          // 生命周期语义：LEFT/REMOVED 成员保留历史统计与身份，但角色统一显示 removed
          return {
            user_id: userId,
            member_id: member?.id ?? null,
            sesame_number: user?.sesameNumber ?? null,
            display_name: user?.profile?.displayName ?? member?.displayName ?? (memberId ? '已移除成员' : '未知记录人'),
            avatar_url: user?.profile?.avatarFileId
              ? `/api/v1/profile/avatar/${userId}?v=${user.profile.avatarVersion}`
              : null,
            avatar_version: user?.profile?.avatarFileId ? user.profile.avatarVersion : 0,
            role: active ? (member!.status === 'ACTIVE' ? member!.role : 'removed') : memberId ? 'removed' : 'unknown',
            expense_total: decimalToCanonical(value.expense),
            tx_count: value.count,
            sort_expense: value.expense,
          };
        });
        items.sort(
          (left, right) =>
            right.sort_expense.comparedTo(left.sort_expense) ||
            right.tx_count - left.tx_count ||
            (left.user_id ?? '').localeCompare(right.user_id ?? ''),
        );

        return {
          ledger_id: ledgerId,
          ledger_currency: ledger.currency,
          scope,
          period: range.period,
          start_at: range.startAt?.toISOString() ?? null,
          end_at: range.endAt?.toISOString() ?? null,
          items: items.map(({ sort_expense: _expense, ...item }) => item),
        };
      }),
  );
}

/** 按客户端本地时区和账本月起始日计算统计的左闭右开 UTC 范围。 */
export function analyticsRange(
  scope: AnalyticsScope,
  period: string | undefined,
  timezoneOffsetMinutes: number,
  monthStartDay: number,
  now = new Date(),
): AnalyticsRange {
  if (scope === 'all') return { period: null, startAt: null, endAt: null };
  const day = Math.min(31, Math.max(1, monthStartDay));
  const localNow = new Date(now.getTime() + timezoneOffsetMinutes * 60_000);
  if (scope === 'month') {
    let year = localNow.getUTCFullYear();
    let month = localNow.getUTCMonth() + 1;
    if (period) {
      if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(period))
        throw new ApiError(400, 'INVALID_ANALYTICS_PERIOD', '统计周期格式无效');
      year = Number(period.slice(0, 4));
      month = Number(period.slice(5, 7));
    } else if (now < localMidnightToUtc(year, month, day, timezoneOffsetMinutes)) {
      month -= 1;
      if (month === 0) {
        year -= 1;
        month = 12;
      }
    }
    const endYear = month === 12 ? year + 1 : year;
    const endMonth = month === 12 ? 1 : month + 1;
    return {
      period: `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}`,
      startAt: localMidnightToUtc(year, month, day, timezoneOffsetMinutes),
      endAt: localMidnightToUtc(endYear, endMonth, day, timezoneOffsetMinutes),
    };
  }

  let year = localNow.getUTCFullYear();
  if (period) {
    if (!/^\d{4}$/.test(period)) throw new ApiError(400, 'INVALID_ANALYTICS_PERIOD', '统计周期格式无效');
    year = Number(period);
  } else if (localNow.getUTCMonth() === 0 && localNow.getUTCDate() < day) {
    year -= 1;
  }
  return {
    period: year.toString().padStart(4, '0'),
    startAt: localMidnightToUtc(year, 1, day, timezoneOffsetMinutes),
    endAt: localMidnightToUtc(year + 1, 1, day, timezoneOffsetMinutes),
  };
}

/** 月起始日超出当月天数时取月末，再将本地零点转为 UTC；正偏移代表东半球。 */
function localMidnightToUtc(year: number, month: number, day: number, timezoneOffsetMinutes: number): Date {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1, Math.min(day, lastDay)) - timezoneOffsetMinutes * 60_000);
}
