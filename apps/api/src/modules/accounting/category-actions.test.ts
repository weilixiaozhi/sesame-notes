import type { Category, PrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../../shared/api-config.js';
import { CategorySchema } from '../../shared/contracts/accounting.js';
import { ErrorSchema } from '../../shared/contracts/errors.js';
import { registerCategoryActionRoutes } from './category-actions.js';

const hooks = vi.hoisted(() => ({
  transaction: vi.fn(),
  access: vi.fn(),
  session: vi.fn(),
  event: vi.fn(),
  replay: vi.fn(),
  store: vi.fn(),
  updateTransaction: vi.fn(),
  deleteTransaction: vi.fn(),
}));
vi.mock('../auth/index.js', () => ({
  authenticate: () => async () => {},
  requireScopes: () => async () => {},
  requireAuth: () => ({
    userId: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222',
  }),
  currentSessionAccess: hooks.session,
}));
vi.mock('../../shared/sync-transaction.js', () => ({ withSyncTransaction: hooks.transaction }));
vi.mock('./domain/ledger-access.js', () => ({ getLedgerReadAccess: hooks.access, getLedgerWriteAccess: hooks.access }));
vi.mock('../sync-events/index.js', () => ({ createChange: hooks.event }));
vi.mock('../../shared/idempotency.js', async (original) => ({
  ...(await original<typeof import('../../shared/idempotency.js')>()),
  findIdempotentReplay: hooks.replay,
  storeIdempotentResult: hooks.store,
}));
vi.mock('./transaction-mutations.js', () => ({
  updateTransactionMutation: hooks.updateTransaction,
  deleteTransactionMutation: hooks.deleteTransaction,
}));

const ownerId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';
const ledgerId = '33333333-3333-4333-8333-333333333333';
const parentId = '44444444-4444-4444-8444-444444444444';
const childId = '55555555-5555-4555-8555-555555555555';
const targetId = '66666666-6666-4666-8666-666666666666';
const base = Date.parse('2026-10-03T12:00:00.000Z');
const time = (offset: number) => new Date(base + offset);
const auth = { userId: ownerId, deviceId };
type Query = { where: Record<string, unknown>; select?: Record<string, boolean>; orderBy?: unknown };
type Transaction = {
  id: string;
  ownerId: string;
  ledgerId: string;
  categoryId: string | null;
  revision: number;
  updatedAt: Date;
  deletedAt: Date | null;
};
type Rule = {
  id: string;
  ownerId: string;
  ledgerId: string;
  categoryId: string | null;
  updatedAt: Date;
  deletedAt: Date | null;
  enabled: boolean;
};
type Event = {
  ledgerId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  payload: Record<string, unknown>;
  updatedAt: Date;
};
type TransactionCommand = {
  ledgerId: string;
  transactionId: string;
  baseRevision: number;
  updatedAt: Date;
  fields?: Record<string, unknown>;
  historyChanges?: unknown;
};
const applications: FastifyInstance[] = [];

function category(id: string, level: 1 | 2, parent: string | null, offset: number): Category {
  return {
    id,
    ownerId,
    name: id === parentId ? 'Food' : id === childId ? 'Breakfast' : 'Other',
    kind: 'expense',
    level,
    parentId: parent,
    sortOrder: 0,
    icon: null,
    createdAt: time(-1000),
    updatedAt: time(offset),
    updatedByDeviceId: deviceId,
    deletedAt: null,
  };
}

/** Real handlers and snapshot cascades; only explicitly supported database operations exist. */
function fixture(withRelations = false) {
  const categories = [
    category(parentId, 1, null, 4000),
    category(childId, 2, parentId, 5000),
    category(targetId, 1, null, 1000),
  ];
  const transactions: Transaction[] = withRelations
    ? [
        {
          id: '77777777-7777-4777-8777-777777777777',
          ownerId,
          ledgerId,
          categoryId: parentId,
          revision: 1,
          updatedAt: time(8000),
          deletedAt: null,
        },
      ]
    : [];
  const rules: Rule[] = withRelations
    ? [
        {
          id: '88888888-8888-4888-8888-888888888888',
          ownerId,
          ledgerId,
          categoryId: parentId,
          updatedAt: time(6000),
          deletedAt: null,
          enabled: true,
        },
      ]
    : [];
  const ledger = {
    id: ledgerId,
    ownerId,
    syncId: ledgerId,
    name: 'Clock regression',
    currency: 'CNY',
    monthStartDay: 1,
    aaEnabled: false,
    deletedAt: null,
    updatedAt: time(7000),
  };
  const events: Event[] = [];
  const receipts = new Map<string, { hash: string; response: unknown }>();
  const clone = <T>(value: T): T => structuredClone(value);
  const idList = (value: unknown): string[] => {
    expect(value).toEqual({ in: expect.any(Array) });
    const result = (value as { in: string[] }).in;
    expect(result.every((id) => categories.some((row) => row.id === id))).toBe(true);
    return result;
  };
  const tx = {
    category: {
      findMany: vi.fn(async (query: Query) => {
        const where = query.where;
        if (where.kind) {
          expect(query.select).toEqual({ id: true, name: true });
          expect(where.ownerId).toBe(ownerId);
          expect(where.kind).toBe('expense');
          expect(where.deletedAt).toBeNull();
          const excluded = (where.id as { notIn: string[] }).notIn;
          return clone(
            categories
              .filter(
                (row) =>
                  !row.deletedAt &&
                  row.kind === where.kind &&
                  row.level === where.level &&
                  row.parentId === where.parentId &&
                  !excluded.includes(row.id),
              )
              .map((row) => ({ id: row.id, name: row.name })),
          );
        }
        if (where.OR) {
          expect(query).toEqual({
            where: {
              ownerId,
              deletedAt: null,
              OR: [{ id: { in: expect.any(Array) } }, { parentId: { in: expect.any(Array) } }],
            },
            orderBy: { id: 'asc' },
          });
          const clauses = where.OR as [{ id: unknown }, { parentId: unknown }];
          const ids = idList(clauses[0].id);
          expect(clauses[1].parentId).toEqual({ in: ids });
          return clone(
            categories
              .filter(
                (row) =>
                  !row.deletedAt && (ids.includes(row.id) || (row.parentId !== null && ids.includes(row.parentId))),
              )
              .sort((a, b) => a.id.localeCompare(b.id)),
          );
        }
        if (where.level === 1) {
          expect(query).toEqual({ where: { ownerId, deletedAt: null, level: 1, id: { notIn: expect.any(Array) } } });
          const excluded = (where.id as { notIn: string[] }).notIn;
          return clone(categories.filter((row) => !row.deletedAt && row.level === 1 && !excluded.includes(row.id)));
        }
        expect(query).toEqual({
          where: { ownerId, id: { in: expect.any(Array) }, deletedAt: null },
          ...(query.orderBy ? { orderBy: { id: 'asc' } } : {}),
        });
        const ids = idList(where.id);
        return clone(
          categories.filter((row) => !row.deletedAt && ids.includes(row.id)).sort((a, b) => a.id.localeCompare(b.id)),
        );
      }),
      findFirst: vi.fn(async (query: Query) => {
        expect(query).toEqual({ where: { id: targetId, ownerId, deletedAt: null } });
        return clone(categories.find((row) => row.id === targetId && !row.deletedAt) ?? null);
      }),
      update: vi.fn(
        async (query: { where: { id_ownerId: { id: string; ownerId: string } }; data: Partial<Category> }) => {
          expect(query.where.id_ownerId.ownerId).toBe(ownerId);
          expect(
            Object.keys(query.data).every((key) =>
              ['sortOrder', 'level', 'parentId', 'deletedAt', 'updatedAt', 'updatedByDeviceId'].includes(key),
            ),
          ).toBe(true);
          const row = categories.find((item) => item.id === query.where.id_ownerId.id);
          if (!row) throw new Error('Unexpected category update');
          Object.assign(row, clone(query.data));
          return clone(row);
        },
      ),
    },
    transaction: {
      findMany: vi.fn(async (query: Query) => {
        expect(query.where).toEqual({
          ownerId,
          categoryId: { in: expect.any(Array) },
          deletedAt: null,
          ledger: { deletedAt: null },
        });
        expect(query.orderBy).toEqual({ id: 'asc' });
        expect(query.select).toEqual({
          id: true,
          ledgerId: true,
          categoryId: true,
          revision: true,
          ...(query.select?.updatedAt ? { updatedAt: true } : {}),
        });
        const ids = idList(query.where.categoryId);
        return clone(
          transactions
            .filter((row) => row.categoryId && ids.includes(row.categoryId) && !row.deletedAt)
            .map((row) =>
              Object.fromEntries(Object.keys(query.select!).map((key) => [key, row[key as keyof Transaction]])),
            ),
        );
      }),
    },
    recurringTransaction: {
      findMany: vi.fn(async (query: Query) => {
        expect(query).toEqual({
          where: { categoryId: { in: expect.any(Array) }, deletedAt: null, ledger: { ownerId, deletedAt: null } },
          orderBy: { id: 'asc' },
        });
        const ids = idList(query.where.categoryId);
        return clone(rules.filter((row) => row.categoryId && ids.includes(row.categoryId) && !row.deletedAt));
      }),
      update: vi.fn(async (query: { where: { id: string }; data: Partial<Rule> & { updatedByDeviceId: string } }) => {
        expect(
          Object.keys(query.data).every((key) =>
            ['categoryId', 'enabled', 'updatedAt', 'updatedByDeviceId'].includes(key),
          ),
        ).toBe(true);
        expect(query.data.updatedByDeviceId).toBe(deviceId);
        const row = rules.find((item) => item.id === query.where.id);
        if (!row) throw new Error('Unexpected recurring update');
        Object.assign(row, clone(query.data));
        return clone(row);
      }),
    },
    ledger: {
      findMany: vi.fn(async (query: Query) => {
        if (query.where.id) {
          expect(query).toEqual({ where: { id: { in: [ledgerId] }, ownerId, deletedAt: null } });
          return [clone(ledger)];
        }
        expect(Object.keys(query.where).sort()).toEqual(['OR', 'deletedAt', 'ownerId']);
        expect(query.where.ownerId).toBe(ownerId);
        expect(query.where.deletedAt).toBeNull();
        const clauses = query.where.OR as Array<
          Record<string, { some: { ownerId: string; categoryId: string | { in: string[] } } }>
        >;
        expect(clauses).toHaveLength(2);
        expect(Object.keys(clauses[0]!)).toEqual(['transactions']);
        expect(Object.keys(clauses[1]!)).toEqual(['recurringTransactions']);
        const related = clauses[0]!.transactions!.some;
        expect(clauses[1]!.recurringTransactions!.some).toEqual(related);
        expect(related.ownerId).toBe(ownerId);
        const ids = typeof related.categoryId === 'string' ? [related.categoryId] : idList(related.categoryId);
        expect(ids.every((id) => categories.some((row) => row.id === id))).toBe(true);
        const hasReference =
          transactions.some((row) => row.categoryId && ids.includes(row.categoryId)) ||
          rules.some((row) => row.categoryId && ids.includes(row.categoryId));
        return hasReference ? [clone(ledger)] : [];
      }),
    },
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?').replace(/\s+/g, ' ').trim();
      expect(values[0]).toBe(ownerId);
      const id = values[1] as string;
      expect(categories.some((row) => row.id === id)).toBe(true);
      if (
        sql ===
        'UPDATE transactions SET category_id = NULL, category_name = NULL, category_kind = NULL WHERE owner_id = ?::uuid AND category_id = ?::uuid'
      ) {
        for (const row of transactions) if (row.categoryId === id) row.categoryId = null;
        return 1;
      }
      expect(sql).toBe(
        'UPDATE recurring_transactions SET category_id = NULL WHERE owner_id = ?::uuid AND category_id = ?::uuid',
      );
      for (const row of rules) if (row.categoryId === id) row.categoryId = null;
      return 1;
    }),
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>, options: unknown) => {
      expect(options).toEqual({ isolationLevel: 'RepeatableRead' });
      return operation(tx);
    }),
  };
  hooks.transaction.mockImplementation(async (client, operation) => {
    expect(client).toBe(prisma);
    return operation(tx);
  });
  hooks.access.mockImplementation(async (client, user, id, role) => {
    expect(client).toBe(tx);
    expect(user).toBe(ownerId);
    expect(id).toBe(ledgerId);
    expect(role).toBe('owner');
    return { ledger: clone(ledger) };
  });
  hooks.session.mockImplementation(async (client, identity) => {
    expect(client).toBe(tx);
    expect(identity).toEqual(auth);
    return true;
  });
  hooks.event.mockImplementation(async (client, identity, scope, entityType, entityId, action, payload, updatedAt) => {
    expect(client).toBe(tx);
    expect(identity).toEqual(auth);
    expect(['category', 'ledger']).toContain(entityType);
    events.push(clone({ ledgerId: scope, entityType, entityId, action, payload, updatedAt }));
  });
  hooks.replay.mockImplementation(async (client, user, key, hash) => {
    expect(client).toBe(tx);
    expect(user).toBe(ownerId);
    const receipt = receipts.get(key);
    if (receipt && receipt.hash !== hash) throw new Error('Unexpected changed replay');
    return clone(receipt?.response ?? null);
  });
  hooks.store.mockImplementation(async (client, user, key, hash, response) => {
    expect(client).toBe(tx);
    expect(user).toBe(ownerId);
    expect(receipts.has(key)).toBe(false);
    receipts.set(key, { hash, response: clone(response) });
  });
  const mutateTransaction = async (
    client: unknown,
    identity: unknown,
    command: TransactionCommand,
    deleted: boolean,
  ) => {
    expect(client).toBe(tx);
    expect(identity).toEqual(auth);
    expect(command.ledgerId).toBe(ledgerId);
    const row = transactions.find((item) => item.id === command.transactionId);
    if (!row) throw new Error('Unexpected transaction mutation');
    expect(command.baseRevision).toBe(row.revision);
    row.updatedAt = clone(command.updatedAt);
    row.revision++;
    if (deleted) row.deletedAt = clone(command.updatedAt);
    else row.categoryId = command.fields!.categoryId as string | null;
    return { status: 'applied' };
  };
  hooks.updateTransaction.mockImplementation((client, identity, command) =>
    mutateTransaction(client, identity, command, false),
  );
  hooks.deleteTransaction.mockImplementation((client, identity, command) =>
    mutateTransaction(client, identity, command, true),
  );
  return { categories, transactions, rules, ledger, events, tx, prisma };
}

async function harness(withRelations = false) {
  const state = fixture(withRelations);
  const app = Fastify({ logger: false });
  applications.push(app);
  app.addSchema(CategorySchema);
  app.addSchema(ErrorSchema);
  registerCategoryActionRoutes(app, state.prisma as unknown as PrismaClient, {} as ApiConfig);
  await app.ready();
  const call = (operation: string, body: object, key?: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/ledgers/${ledgerId}/categories/${operation}`,
      payload: body,
      headers: key ? { 'idempotency-key': key } : {},
    });
  return { ...state, call };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(base);
});
afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
  vi.useRealTimers();
});

describe('category action clocks without a database or listening server', () => {
  it('reorder advances future clocks and keeps row, response and event consistent; no-op and lost-response replay emit nothing', async () => {
    const ctx = await harness();
    const before = structuredClone(ctx.categories);
    const unchanged = { items: [{ id: parentId, sort_order: 0, expected_updated_at: time(4000).toISOString() }] };
    expect((await ctx.call('reorder', unchanged)).statusCode).toBe(200);
    expect(ctx.events).toHaveLength(0);
    const body = {
      items: [
        { id: parentId, sort_order: 2, expected_updated_at: time(4000).toISOString() },
        { id: childId, sort_order: 3, expected_updated_at: time(5000).toISOString() },
      ],
    };
    const response = await ctx.call('reorder', body);
    expect(response.statusCode, response.body).toBe(200);
    const replay = await ctx.call('reorder', body);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(response.json());
    expect(ctx.events).toHaveLength(2);
    for (const event of ctx.events) {
      const previous = before.find((row) => row.id === event.entityId)!;
      const current = ctx.categories.find((row) => row.id === event.entityId)!;
      expect(current.updatedAt.getTime()).toBeGreaterThan(previous.updatedAt.getTime());
      expect(event.updatedAt).toEqual(current.updatedAt);
      expect(event.payload.updated_at).toBe(current.updatedAt.toISOString());
      expect(
        response.json<Array<{ id: string; updated_at: string }>>().find((row) => row.id === current.id)?.updated_at,
      ).toBe(event.payload.updated_at);
    }
  });

  it.each(['migrate', 'delete', 'promote'] as const)(
    '%s advances categories and linked records together, including requires_full events; identical key replay has no writes',
    async (mode) => {
      const ctx = await harness(true);
      // Each mode gives a different related entity the latest clock, so omitting
      // categories, rules or invalidated ledgers from the batch maximum fails.
      if (mode === 'migrate') ctx.ledger.updatedAt = time(11000);
      if (mode === 'delete') ctx.rules[0]!.updatedAt = time(12000);
      if (mode === 'promote') ctx.categories.find((row) => row.id === childId)!.updatedAt = time(13000);
      const before = structuredClone({
        categories: ctx.categories,
        transactions: ctx.transactions,
        rules: ctx.rules,
        ledger: ctx.ledger,
      });
      const preview = await ctx.call('removal-preview', { category_ids: [parentId] });
      expect(preview.statusCode, preview.body).toBe(200);
      const body = {
        category_ids: [parentId],
        mode,
        preview_token: preview.json<{ preview_token: string }>().preview_token,
        ...(mode === 'migrate'
          ? { target_category_id: targetId, expected_target_updated_at: time(1000).toISOString() }
          : {}),
      };
      const response = await ctx.call('remove', body, 'same-removal-command');
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        removed_categories: mode === 'promote' ? 1 : 2,
        promoted_categories: mode === 'promote' ? 1 : 0,
        affected_transactions: 1,
        affected_recurring_rules: 1,
      });
      const after = structuredClone({
        categories: ctx.categories,
        transactions: ctx.transactions,
        rules: ctx.rules,
        events: ctx.events,
      });
      const writes = {
        categories: ctx.tx.category.update.mock.calls.length,
        rules: ctx.tx.recurringTransaction.update.mock.calls.length,
        raw: ctx.tx.$executeRaw.mock.calls.length,
        updates: hooks.updateTransaction.mock.calls.length,
        deletes: hooks.deleteTransaction.mock.calls.length,
      };
      const replay = await ctx.call('remove', body, 'same-removal-command');
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toEqual(response.json());
      expect({
        categories: ctx.categories,
        transactions: ctx.transactions,
        rules: ctx.rules,
        events: ctx.events,
      }).toEqual(after);
      expect({
        categories: ctx.tx.category.update.mock.calls.length,
        rules: ctx.tx.recurringTransaction.update.mock.calls.length,
        raw: ctx.tx.$executeRaw.mock.calls.length,
        updates: hooks.updateTransaction.mock.calls.length,
        deletes: hooks.deleteTransaction.mock.calls.length,
      }).toEqual(writes);
      const changed = ctx.categories.filter((row) => row.id !== targetId);
      for (const row of changed) {
        expect(row.updatedAt.getTime()).toBeGreaterThan(
          before.categories.find((previous) => previous.id === row.id)!.updatedAt.getTime(),
        );
        const event = ctx.events.find((item) => item.entityType === 'category' && item.entityId === row.id)!;
        expect(event).toBeDefined();
        expect(event.updatedAt).toEqual(row.updatedAt);
        expect(event.payload.updated_at).toBe(row.updatedAt.toISOString());
        expect(event.payload.deleted_at).toBe(row.deletedAt?.toISOString() ?? null);
        if (row.deletedAt) expect(row.deletedAt).toEqual(row.updatedAt);
      }
      expect(ctx.transactions[0]!.updatedAt.getTime()).toBeGreaterThan(before.transactions[0]!.updatedAt.getTime());
      expect(ctx.rules[0]!.updatedAt.getTime()).toBeGreaterThan(before.rules[0]!.updatedAt.getTime());
      expect(ctx.transactions[0]!.updatedAt).toEqual(changed[0]!.updatedAt);
      expect(ctx.rules[0]!.updatedAt).toEqual(changed[0]!.updatedAt);
      expect(ctx.rules[0]).toMatchObject({
        categoryId: null,
        enabled: before.rules[0]!.enabled,
      });
      const invalidations = ctx.events.filter((event) => event.entityType === 'ledger');
      expect(invalidations.length).toBeGreaterThan(0);
      for (const event of invalidations) {
        expect(event.entityId).toBe(ledgerId);
        expect(event.ledgerId).toBe(ledgerId);
        expect(event.payload.requires_full).toBe(true);
        expect(event.updatedAt.getTime()).toBeGreaterThan(before.ledger.updatedAt.getTime());
        expect(event.updatedAt).toEqual(changed[0]!.updatedAt);
      }
      if (mode === 'promote')
        expect(ctx.categories.find((row) => row.id === childId)).toMatchObject({
          level: 1,
          parentId: null,
          deletedAt: null,
        });
    },
  );
});
