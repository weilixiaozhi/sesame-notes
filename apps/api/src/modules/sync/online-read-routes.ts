import { Prisma, type PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

import type { ApiConfig } from '../../shared/api-config.js';
import { AnyUuidSchema, UuidSchema, ANY_UUID_PATTERN } from '../../shared/contracts/scalars.js';
import { MemberSchema } from '../../shared/contracts/accounting.js';
import { getLedgerReadAccess } from '../accounting/index.js';
import { memberSnapshot } from './sync-snapshots.js';
import { ErrorSchema } from '../../shared/contracts/errors.js';
import { ApiError } from '../../shared/errors.js';
import { DateRangeQuerySchema, dateRange } from '../../shared/date-range.js';
import { execute } from '../../shared/execute.js';
import { decodeTransactionCursor, encodeTransactionCursor } from '../../shared/pagination.js';
import { authenticate, requireAuth, requireScopes } from '../auth/index.js';
import { MemoEntrySchema, memoEntrySnapshot } from '../memos/index.js';
import { DayEventSchema, dayEventSnapshot } from '../days/index.js';
import { fitnessPayloadSchemas, fitnessSnapshot } from '../fitness/index.js';

const QuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  sync_id: Type.Optional(UuidSchema),
});
const NextCursorSchema = Type.Union([Type.String(), Type.Null()]);
const MemoQuerySchema = Type.Object({ ...QuerySchema.properties, ...DateRangeQuerySchema.properties });
type PageQuery = {
  limit?: number;
  cursor?: string;
  sync_id?: string;
  start_at?: string;
  end_at?: string;
  time_zone?: string;
  exercise_id?: string;
};
const WorkoutQuerySchema = Type.Object({
  ...QuerySchema.properties,
  exercise_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});

/** 分页浏览云端数据；所有权和本子代次在同一读取事务内校验，写入继续统一走同步变更协议。 */
export function registerOnlineReadRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')] };
  app.get(
    '/api/v1/ledgers/:ledger_id/participants',
    {
      ...secured,
      schema: {
        tags: ['sharing'],
        params: Type.Object({ ledger_id: AnyUuidSchema }),
        response: { 200: Type.Array(Type.Ref(MemberSchema)) },
      },
    },
    async (request) =>
      execute(request, '读取账本参与者', async () => {
        const { userId } = requireAuth(request);
        const { ledger_id: id } = request.params as { ledger_id: string };
        return prisma.$transaction(
          async (tx) => {
            await getLedgerReadAccess(tx, userId, id, 'editor');
            const rows = await tx.ledgerMember.findMany({
              where: { ledgerId: id },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            });
            return rows.map(memberSnapshot);
          },
          { isolationLevel: 'RepeatableRead' },
        );
      }),
  );
  app.get(
    '/api/v1/memo-books/:memo_book_id/entries',
    {
      ...secured,
      schema: {
        tags: ['memos'],
        params: Type.Object({ memo_book_id: AnyUuidSchema }),
        querystring: MemoQuerySchema,
        response: {
          412: Type.Ref(ErrorSchema),
          200: Type.Object({ items: Type.Array(Type.Ref(MemoEntrySchema)), next_cursor: NextCursorSchema }),
        },
      },
    },
    async (request) =>
      execute(request, '读取备忘录', async () => {
        const { userId } = requireAuth(request);
        const { memo_book_id: id } = request.params as { memo_book_id: string };
        const query = request.query as PageQuery;
        return prisma.$transaction(
          async (tx) => {
            const book = await tx.memoBook.findFirst({ where: { id, ownerId: userId, deletedAt: null } });
            if (!book) throw new ApiError(404, 'MEMO_BOOK_NOT_FOUND', '备忘录本不存在或无权访问');
            verifyGeneration(query, book.syncId);
            const { limit, before, orderBy } = memoPageOptions(query, book.type);
            const { start, end } = dateRange(query);
            const rows = await tx.memoEntry.findMany({
              where: {
                memoBookId: id,
                deletedAt: null,
                AND: [before, { updatedAt: { ...(start ? { gte: start } : {}), ...(end ? { lt: end } : {}) } }],
              },
              orderBy,
              take: limit + 1,
            });
            const page = pageRows(rows, limit);
            if (book.type === 'credentials' && page.next_cursor) {
              const last = page.items.at(-1)!;
              page.next_cursor = Buffer.from(
                JSON.stringify({ v: 2, k: last.orderKey?.toString() ?? null, i: last.id }),
              ).toString('base64url');
            }
            return { items: page.items.map((row) => memoEntrySnapshot(row, book)), next_cursor: page.next_cursor };
          },
          { isolationLevel: 'RepeatableRead' },
        );
      }),
  );

  app.get(
    '/api/v1/day-books/:day_book_id/events',
    {
      ...secured,
      schema: {
        tags: ['days'],
        params: Type.Object({ day_book_id: AnyUuidSchema }),
        querystring: QuerySchema,
        response: {
          412: Type.Ref(ErrorSchema),
          200: Type.Object({ items: Type.Array(Type.Ref(DayEventSchema)), next_cursor: NextCursorSchema }),
        },
      },
    },
    async (request) =>
      execute(request, '读取纪念日', async () => {
        const { userId } = requireAuth(request);
        const { day_book_id: id } = request.params as { day_book_id: string };
        const query = request.query as PageQuery;
        const { limit, before } = pageOptions(query);
        return prisma.$transaction(
          async (tx) => {
            const book = await tx.dayBook.findFirst({ where: { id, ownerId: userId, deletedAt: null } });
            if (!book) throw new ApiError(404, 'DAY_BOOK_NOT_FOUND', '纪念日本不存在或无权访问');
            verifyGeneration(query, book.syncId);
            const rows = await tx.dayEvent.findMany({
              where: { dayBookId: id, deletedAt: null, ...before },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: limit + 1,
            });
            const page = pageRows(rows, limit);
            return {
              items: page.items.map((row) => dayEventSnapshot(row, book.syncId)),
              next_cursor: page.next_cursor,
            };
          },
          { isolationLevel: 'RepeatableRead' },
        );
      }),
  );

  app.get(
    '/api/v1/memo-books/:memo_book_id/calendar-counts',
    {
      ...secured,
      schema: {
        tags: ['memos'],
        params: Type.Object({ memo_book_id: AnyUuidSchema }),
        querystring: Type.Object({ ...DateRangeQuerySchema.properties, sync_id: Type.Optional(UuidSchema) }),
        response: {
          200: Type.Object({
            days: Type.Array(Type.Object({ date: Type.String(), count: Type.Integer({ minimum: 0 }) })),
          }),
        },
      },
    },
    async (request) =>
      execute(request, '读取备忘日历计数', async () => {
        const { userId } = requireAuth(request);
        const { memo_book_id: id } = request.params as { memo_book_id: string };
        const query = request.query as PageQuery;
        const { start, end, timeZone } = dateRange(query);
        return prisma.$transaction(
          async (tx) => {
            const book = await tx.memoBook.findFirst({ where: { id, ownerId: userId, deletedAt: null } });
            if (!book) throw new ApiError(404, 'MEMO_BOOK_NOT_FOUND', '备忘本不存在或无权访问');
            verifyGeneration(query, book.syncId);
            const days = await tx.$queryRaw<Array<{ date: string; count: bigint }>>(Prisma.sql`
        SELECT to_char(updated_at AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS date, COUNT(*) AS count
        FROM memo_entries WHERE memo_book_id=${id}::uuid AND deleted_at IS NULL
        ${start ? Prisma.sql`AND updated_at >= ${start}` : Prisma.empty}
        ${end ? Prisma.sql`AND updated_at < ${end}` : Prisma.empty}
        GROUP BY date ORDER BY date`);
            return { days: days.map((row) => ({ date: row.date, count: Number(row.count) })) };
          },
          { isolationLevel: 'RepeatableRead' },
        );
      }),
  );

  const fitnessRoutes = {
    templates: 'fitness_template',
    plans: 'fitness_plan',
    workouts: 'fitness_workout',
    preferences: 'fitness_preferences',
  } as const;
  for (const [path, type] of Object.entries(fitnessRoutes)) {
    const payload = fitnessPayloadSchemas[type];
    const schema = Type.Object({
      ...payload.properties,
      id: AnyUuidSchema,
      fitness_space_id: AnyUuidSchema,
      sync_id: UuidSchema,
      revision: Type.Integer({ minimum: 1 }),
      deleted_at: Type.Union([Type.String(), Type.Null()]),
    });
    app.get(
      `/api/v1/fitness-spaces/:fitness_space_id/${path}`,
      {
        ...secured,
        schema: {
          tags: ['fitness'],
          params: Type.Object({ fitness_space_id: AnyUuidSchema }),
          querystring: type === 'fitness_workout' ? WorkoutQuerySchema : QuerySchema,
          response: {
            412: Type.Ref(ErrorSchema),
            200: Type.Object({ items: Type.Array(schema), next_cursor: NextCursorSchema }),
          },
        },
      },
      async (request) =>
        execute(request, '读取健身数据', async () => {
          const { userId } = requireAuth(request);
          const { fitness_space_id: id } = request.params as { fitness_space_id: string };
          const query = request.query as PageQuery;
          const { limit, before } = pageOptions(query);
          return prisma.$transaction(
            async (tx) => {
              const space = await tx.fitnessSpace.findFirst({ where: { id, ownerId: userId, deletedAt: null } });
              if (!space) throw new ApiError(404, 'FITNESS_SPACE_NOT_FOUND', '健身空间不存在或无权访问');
              verifyGeneration(query, space.syncId);
              const rows = await tx.fitnessEntity.findMany({
                where: {
                  fitnessSpaceId: id,
                  entityType: type,
                  deletedAt: null,
                  ...before,
                  ...(type === 'fitness_workout' && query.exercise_id
                    ? {
                        payload: {
                          path: ['exercises'],
                          array_contains: [{ exercise_id: query.exercise_id, sets: [{ completed: true }] }],
                        },
                      }
                    : {}),
                },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: limit + 1,
              });
              const page = pageRows(rows, limit);
              return { items: page.items.map((row) => fitnessSnapshot(row, space)), next_cursor: page.next_cursor };
            },
            { isolationLevel: 'RepeatableRead' },
          );
        }),
    );
  }
}

/** 以创建时间和稳定 ID 做游标分页，避免删除上一页数据造成后续页丢失。 */
function pageOptions(query: PageQuery) {
  try {
    const cursor = query.cursor ? decodeTransactionCursor(query.cursor) : null;
    return {
      limit: query.limit ?? 50,
      before: cursor
        ? { OR: [{ createdAt: { lt: cursor.happenedAt } }, { createdAt: cursor.happenedAt, id: { lt: cursor.id } }] }
        : {},
    };
  } catch {
    throw new ApiError(400, 'INVALID_CURSOR', '分页游标无效，请刷新后重试');
  }
}

/** 从多取的一行判断是否还有后续页，并保留统一快照响应。 */
function pageRows<T extends { id: string; createdAt: Date }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    next_cursor:
      rows.length > limit && last ? encodeTransactionCursor({ id: last.id, happenedAt: last.createdAt }) : null,
  };
}

/** 防止客户端继续浏览已经删除并重新创建的同名资源。 */
function verifyGeneration(query: PageQuery, syncId: string): void {
  if (query.sync_id !== undefined && query.sync_id !== syncId) {
    throw new ApiError(412, 'SYNC_ID_MISMATCH', '数据版本已经变化，请刷新后重试');
  }
}

/** 凭据卡片按用户排序键分页；普通备忘录沿用创建时间倒序。 */
function memoPageOptions(
  query: PageQuery,
  type: string,
): { limit: number; before: Prisma.MemoEntryWhereInput; orderBy: Prisma.MemoEntryOrderByWithRelationInput[] } {
  if (type !== 'credentials') return { ...pageOptions(query), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] };
  try {
    let before: Prisma.MemoEntryWhereInput = {};
    if (query.cursor) {
      const value: unknown = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (!value || typeof value !== 'object') throw new Error('INVALID_CURSOR');
      const cursor = value as Record<string, unknown>;
      if (
        cursor.v !== 2 ||
        typeof cursor.i !== 'string' ||
        !new RegExp(ANY_UUID_PATTERN).test(cursor.i) ||
        !(
          cursor.k === null ||
          (typeof cursor.k === 'string' &&
            /^(?:0|[1-9]\d{0,18})$/.test(cursor.k) &&
            BigInt(cursor.k) <= 9223372036854775807n)
        )
      )
        throw new Error('INVALID_CURSOR');
      before =
        cursor.k === null
          ? { orderKey: null, id: { gt: cursor.i } }
          : {
              OR: [
                { orderKey: { gt: BigInt(cursor.k as string) } },
                { orderKey: BigInt(cursor.k as string), id: { gt: cursor.i } },
                { orderKey: null },
              ],
            };
    }
    return { limit: query.limit ?? 50, before, orderBy: [{ orderKey: 'asc' }, { id: 'asc' }] };
  } catch {
    throw new ApiError(400, 'INVALID_CURSOR', '分页游标无效，请刷新后重试');
  }
}
