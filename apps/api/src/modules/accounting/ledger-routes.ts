import { normalizeName } from '../../shared/text-validation.js';
import { AnyUuidSchema, NameSchema, CurrencySchema, UuidSchema } from '../../shared/contracts/scalars.js';
import { LedgerSchema } from '../../shared/contracts/accounting.js';
import { withSyncTransaction } from '../../shared/sync-transaction.js';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { randomUUID } from 'node:crypto';

import type { ApiConfig } from '../../shared/api-config.js';
import { authenticate, requireAuth, requireScopes, currentSessionAccess } from '../auth/index.js';

import { ApiError } from '../../shared/errors.js';
import { ledgerActionPreview } from './ledger-action-preview.js';
import { execute } from '../../shared/execute.js';
import { createChange } from '../sync-events/index.js';
import { deleteLedgerRecord, nextLedgerTimestamp } from './ledger-mutations.js';
import {
  accessibleLedgerWhere,
  getLedgerReadAccess,
  getLedgerWriteAccess,
  ledgerRoleOf,
} from './domain/ledger-access.js';
import { ledgerPayload, mapLedger } from './mappers.js';
import { ensureOwnerMember } from './owner-member.js';
import { ensureDefaultCategories } from './default-categories.js';

const LedgerInput = Type.Object({
  id: Type.Optional(AnyUuidSchema),
  name: NameSchema,
  currency: Type.Optional(CurrencySchema),
  month_start_day: Type.Optional(Type.Integer({ minimum: 1, maximum: 31 })),
  aa_enabled: Type.Optional(Type.Boolean()),
});

type LedgerCreate = { id?: string; name: string; currency?: string; month_start_day?: number; aa_enabled?: boolean };
type LedgerParams = { ledger_id: string };

/** 注册账本 CRUD 接口，所有写操作与同步事件在同一事务提交。 */
export function registerLedgerRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')] };

  app.get(
    '/api/v1/ledgers',
    {
      ...secured,
      schema: { tags: ['ledgers'], response: { 200: Type.Array(Type.Ref(LedgerSchema)) } },
    },
    async (request) =>
      execute(request, '读取账本列表', async () => {
        const auth = requireAuth(request);
        const ledgers = await prisma.ledger.findMany({
          where: accessibleLedgerWhere(auth.userId),
          include: {
            members: { where: { linkedAccountId: auth.userId, status: 'ACTIVE' }, take: 1 },
            _count: { select: { members: { where: { status: 'ACTIVE' } } } },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        return ledgers.map((ledger) => {
          const role = ledgerRoleOf(ledger, auth.userId, ledger.members[0]);
          // member_count 为 LedgerMember 行数（含 Owner 成员行）
          return mapLedger(ledger, role, ledger._count.members, ledger.members[0]);
        });
      }),
  );

  app.post(
    '/api/v1/ledgers',
    {
      ...secured,
      schema: { tags: ['ledgers'], body: LedgerInput, response: { 201: Type.Ref(LedgerSchema) } },
    },
    async (request, reply) =>
      execute(request, '创建账本', async () => {
        const auth = requireAuth(request);
        const body = request.body as LedgerCreate;
        const now = new Date();
        const ledger = await withSyncTransaction(prisma, async (tx) => {
          // 写锁等待期间的会话撤销必须先于业务校验、幂等回执和任何领域写入生效。
          if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
          await ensureDefaultCategories(tx, auth);
          const created = await tx.ledger.create({
            data: {
              ...(body.id ? { id: body.id } : {}),
              // 同步身份由服务端权威生成，不信任客户端提供
              syncId: randomUUID(),
              ownerId: auth.userId,
              name: normalizeName(body.name),
              currency: body.currency ?? 'CNY',
              monthStartDay: body.month_start_day ?? 1,
              aaEnabled: body.aa_enabled ?? false,
              updatedAt: now,
              updatedByDeviceId: auth.deviceId,
            },
          });
          // Owner 必须是一等 Member：与账本同一事务创建 owner 成员行
          await ensureOwnerMember(tx, created.id, auth.userId, {
            createdAt: now,
            updatedAt: now,
            updatedByDeviceId: auth.deviceId,
          });
          await createChange(tx, auth, created.id, 'ledger', created.id, 'upsert', ledgerPayload(created), now);
          return created;
        });
        await reply.status(201).send(mapLedger(ledger, 'owner', 1));
      }),
  );

  app.get(
    '/api/v1/ledgers/:ledger_id',
    {
      ...secured,
      schema: {
        tags: ['ledgers'],
        params: Type.Object({ ledger_id: AnyUuidSchema }),
        response: { 200: Type.Ref(LedgerSchema) },
      },
    },
    async (request) =>
      execute(request, '读取账本', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId } = request.params as LedgerParams;
        const access = await getLedgerReadAccess(prisma, auth.userId, ledgerId, 'editor');
        const count = await prisma.ledgerMember.count({ where: { ledgerId, status: 'ACTIVE' } });
        const member = await prisma.ledgerMember.findUnique({
          where: { ledgerId_linkedAccountId: { ledgerId, linkedAccountId: auth.userId } },
        });
        return mapLedger(access.ledger, access.role, count, member);
      }),
  );

  app.patch(
    '/api/v1/ledgers/:ledger_id',
    {
      ...secured,
      schema: {
        tags: ['ledgers'],
        params: Type.Object({ ledger_id: AnyUuidSchema }),
        body: Type.Partial(Type.Omit(LedgerInput, ['id'])),
        response: { 200: Type.Ref(LedgerSchema) },
      },
    },
    async (request) =>
      execute(request, '更新账本', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId } = request.params as LedgerParams;
        const body = request.body as Partial<LedgerCreate>;
        const ledger = await withSyncTransaction(prisma, async (tx) => {
          // 写锁等待期间的会话撤销必须先于业务校验、幂等回执和任何领域写入生效。
          if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
          const { ledger: current } = await getLedgerWriteAccess(tx, auth.userId, ledgerId, 'owner');
          const now = nextLedgerTimestamp(current);
          const updated = await tx.ledger.update({
            where: { id: ledgerId },
            data: {
              ...(body.name === undefined ? {} : { name: normalizeName(body.name) }),
              ...(body.currency === undefined ? {} : { currency: body.currency }),
              ...(body.month_start_day === undefined ? {} : { monthStartDay: body.month_start_day }),
              ...(body.aa_enabled === undefined ? {} : { aaEnabled: body.aa_enabled }),
              updatedAt: now,
              updatedByDeviceId: auth.deviceId,
            },
          });
          await createChange(tx, auth, ledgerId, 'ledger', ledgerId, 'upsert', ledgerPayload(updated), now);
          return updated;
        });
        const count = await prisma.ledgerMember.count({ where: { ledgerId, status: 'ACTIVE' } });
        const member = await prisma.ledgerMember.findUnique({
          where: { ledgerId_linkedAccountId: { ledgerId, linkedAccountId: auth.userId } },
        });
        return mapLedger(ledger, 'owner', count, member);
      }),
  );

  app.get(
    '/api/v1/ledgers/:ledger_id/action-preview',
    {
      ...secured,
      schema: {
        tags: ['ledgers'],
        params: Type.Object({ ledger_id: AnyUuidSchema }),
        response: {
          200: Type.Object({
            name: NameSchema,
            currency: CurrencySchema,
            sync_id: UuidSchema,
            fingerprint: Type.String({ pattern: '^[a-f0-9]{64}$' }),
            transaction_count: Type.Integer({ minimum: 0 }),
            recurring_count: Type.Integer({ minimum: 0 }),
            member_count: Type.Integer({ minimum: 0 }),
          }),
        },
      },
    },
    async (request) =>
      execute(request, '预览账本删除或清空范围', async () => {
        const auth = requireAuth(request);
        const { ledger_id: id } = request.params as LedgerParams;
        return prisma.$transaction(
          async (tx) => {
            const { ledger } = await getLedgerReadAccess(tx, auth.userId, id, 'owner');
            return ledgerActionPreview(tx, ledger);
          },
          { isolationLevel: 'RepeatableRead' },
        );
      }),
  );
  app.delete(
    '/api/v1/ledgers/:ledger_id',
    {
      ...secured,
      schema: {
        tags: ['ledgers'],
        params: Type.Object({ ledger_id: AnyUuidSchema }),
        querystring: Type.Object({
          expected_sync_id: UuidSchema,
          expected_fingerprint: Type.String({ pattern: '^[a-f0-9]{64}$' }),
        }),
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) =>
      execute(request, '删除账本', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId } = request.params as LedgerParams;
        await withSyncTransaction(prisma, async (tx) => {
          // 写锁等待期间的会话撤销必须先于业务校验、幂等回执和任何领域写入生效。
          if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
          const query = request.query as { expected_sync_id: string; expected_fingerprint: string };
          const { ledger } = await getLedgerWriteAccess(tx, auth.userId, ledgerId, 'owner');
          if (query.expected_sync_id !== ledger.syncId)
            throw new ApiError(409, 'LEDGER_PREVIEW_CHANGED', '账本已重建，请重新预览');
          if (query.expected_fingerprint !== (await ledgerActionPreview(tx, ledger)).fingerprint)
            throw new ApiError(409, 'LEDGER_PREVIEW_CHANGED', '账本数据已改变，请重新预览并确认');
          const now = nextLedgerTimestamp(ledger);
          const removed = await deleteLedgerRecord(tx, auth, ledgerId, now);
          // 删除事件携带权威归属和墓碑时间，接收端可先隔离正确账号的账本再处理本地副本。
          await createChange(
            tx,
            auth,
            ledgerId,
            'ledger',
            ledgerId,
            'delete',
            { ...ledgerPayload(removed), deleted_at: now.toISOString() },
            now,
          );
        });
        await reply.status(204).send();
      }),
  );
}
