import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';
import { afterAll, expect, it } from 'vitest';
import { deleteAccount } from '../src/modules/accounts/index.js';
import { registeredMemberId } from '../src/modules/accounting/index.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const databaseUrl = testFixtureDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
afterAll(() => prisma.$disconnect());

/** 最小账号夹具包含设备，用于真实外键与会话验证。 */
async function account() {
  try {
    return await prisma.user.create({
      data: {
        phoneE164: `+991${randomInt(1000000000, 9999999999)}`,
        sesameNumber: randomInt(100000000, 1000000000).toString(),
        passwordHash: 'fixture',
        devices: { create: { installationId: randomUUID() } },
      },
      include: { devices: true },
    });
  } catch (cause) {
    throw new Error('账号删除夹具创建失败', { cause });
  }
}

/** 账本与一等Owner在同一事务创建，协作者身份符合UUIDv5数据库约束。 */
async function ledger(ownerId: string, collaboratorId?: string) {
  try {
    const id = randomUUID();
    await prisma.$transaction(async (tx) => {
      await tx.ledger.create({ data: { id, ownerId, name: '删除边界', syncId: randomUUID() } });
      await tx.ledgerMember.createMany({
        data: [ownerId, ...(collaboratorId ? [collaboratorId] : [])].map((userId) => ({
          id: registeredMemberId(id, userId),
          ledgerId: id,
          linkedAccountId: userId,
          displayName: '历史成员',
          memberType: 'REGISTERED',
          role: userId === ownerId ? 'owner' : 'editor',
        })),
      });
    });
    return id;
  } catch (cause) {
    throw new Error('账号删除账本夹具创建失败', { cause });
  }
}

it('活跃共享账本所有者不能直接注销，拒绝时任何数据均不改变', async () => {
  const owner = await account();
  const member = await account();
  const id = await ledger(owner.id, member.id);
  await expect(deleteAccount(prisma, owner.id)).rejects.toMatchObject({
    statusCode: 409,
    code: 'ACCOUNT_OWNS_SHARED_LEDGER',
  });
  expect(await prisma.user.findUnique({ where: { id: owner.id } })).not.toBeNull();
  expect(await prisma.ledgerMember.count({ where: { ledgerId: id } })).toBe(2);
});

it('已删除共享本保留定向墓碑，离线协作者不会重放过期发现事件', async () => {
  const owner = await account();
  const member = await account();
  const id = await ledger(owner.id, member.id);
  const deletedAt = new Date();
  await prisma.ledger.update({ where: { id }, data: { deletedAt } });
  await prisma.syncChange.create({
    data: {
      userId: member.id,
      ledgerId: null,
      scope: 'user',
      entityType: 'ledger',
      entityId: id,
      action: 'upsert',
      mutationId: randomUUID(),
      payload: { requires_full: true },
      updatedAt: new Date(),
      deviceId: member.devices[0]!.id,
      recipientUserId: member.id,
    },
  });
  await deleteAccount(prisma, owner.id);
  const events = await prisma.syncChange.findMany({ where: { entityId: id } });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    action: 'delete',
    ledgerId: null,
    userId: null,
    recipientUserId: member.id,
    payload: { owner_id: owner.id, deleted_at: deletedAt.toISOString() },
  });
});

it('注销清理私有同步数据并保留他人账本历史，解绑事件仍可被其他账号pull', async () => {
  const owner = await account();
  const target = await account();
  const sharedId = await ledger(owner.id, target.id);
  const ownId = await ledger(target.id);
  const memberId = registeredMemberId(sharedId, target.id);
  const transaction = await prisma.transaction.create({
    data: {
      ledgerId: sharedId,
      ownerId: owner.id,
      txType: 'expense',
      amount: '1',
      nativeAmount: '1',
      currencyCode: 'CNY',
      happenedAt: new Date(),
      createdByMemberId: memberId,
      payerMemberId: memberId,
    },
  });
  const now = new Date();
  const memo = await prisma.memoBook.create({
    data: { id: randomUUID(), ownerId: target.id, name: '私有', type: 'normal', createdAt: now, updatedAt: now },
  });
  const day = await prisma.dayBook.create({ data: { ownerId: target.id, name: '日子' } });
  const fitness = await prisma.fitnessSpace.create({
    data: { id: randomUUID(), ownerId: target.id, name: '健身', createdAt: now, updatedAt: now },
  });
  const deviceId = target.devices[0]!.id;
  const sharedEvent = await prisma.syncChange.create({
    data: {
      userId: target.id,
      ledgerId: sharedId,
      scope: 'ledger',
      entityType: 'transaction',
      entityId: transaction.id,
      action: 'upsert',
      mutationId: randomUUID(),
      payload: {},
      updatedAt: now,
      deviceId,
    },
  });
  await prisma.syncChange.createMany({
    data: [
      { entityType: 'memo_book', entityId: memo.id, memoBookId: memo.id },
      { entityType: 'day_book', entityId: day.id, dayBookId: day.id },
      { entityType: 'fitness_space', entityId: fitness.id, fitnessSpaceId: fitness.id },
      { entityType: 'ledger', entityId: ownId, ledgerId: ownId },
    ].map((scope) => ({
      ...scope,
      userId: target.id,
      scope: 'ledgerId' in scope ? 'ledger' : 'user',
      action: 'upsert',
      mutationId: randomUUID(),
      payload: {},
      updatedAt: now,
      deviceId,
    })),
  });
  expect(await deleteAccount(prisma, target.id)).toEqual({ deleted: true, detachedMembers: 1 });
  expect(await prisma.user.findUnique({ where: { id: target.id } })).toBeNull();
  expect(await prisma.ledger.findUnique({ where: { id: ownId } })).toBeNull();
  expect(await prisma.memoBook.findUnique({ where: { id: memo.id } })).toBeNull();
  expect(await prisma.syncChange.count({ where: { entityId: { in: [memo.id, day.id, fitness.id, ownId] } } })).toBe(0);
  expect(await prisma.ledgerMember.findUnique({ where: { id: memberId } })).toMatchObject({
    memberType: 'PLACEHOLDER',
    linkedAccountId: null,
    status: 'REMOVED',
  });
  expect(await prisma.transaction.findUnique({ where: { id: transaction.id } })).toMatchObject({
    createdByMemberId: memberId,
    payerMemberId: memberId,
  });
  expect(await prisma.syncChange.findUnique({ where: { changeId: sharedEvent.changeId } })).toMatchObject({
    userId: null,
    ledgerId: sharedId,
  });
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    JWT_SECRET: 'account-deletion-test-secret-at-least-32-bytes',
    STORAGE_PATH: 'Temp/account-deletion',
  });
  const applicationPrisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const app = buildApp({ prisma: applicationPrisma, config, logger: false });
  try {
    const epoch = await prisma.serverEpoch.findUniqueOrThrow({ where: { id: 0 } });
    const token = await new SignJWT({
      device_id: owner.devices[0]!.id,
      auth_generation: epoch.authGeneration,
      credential_version: owner.credentialVersion,
      scopes: ['sync:read'],
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(owner.id)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(config.jwtSecret));
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/sync/pull?since=0',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().changes).toContainEqual(
      expect.objectContaining({
        entity_type: 'member',
        entity_id: memberId,
        payload: expect.objectContaining({ member_type: 'PLACEHOLDER', linked_account_id: null, status: 'REMOVED' }),
      }),
    );
  } finally {
    await app.close();
  }
  expect(await deleteAccount(prisma, target.id)).toEqual({ deleted: false, detachedMembers: 0 });
});

it('账号删除失败时，成员解绑与同步事件和自有账本一起回滚', async () => {
  const owner = await account();
  const target = await account();
  const sharedId = await ledger(owner.id, target.id);
  const ownId = await ledger(target.id);
  const failing = prisma.$extends({
    query: {
      user: {
        async delete() {
          throw new Error('DELETE_ACCOUNT_PROBE');
        },
      },
    },
  }) as unknown as PrismaClient;
  await expect(deleteAccount(failing, target.id)).rejects.toThrow('账号删除事务失败');
  expect(await prisma.ledger.findUnique({ where: { id: ownId } })).not.toBeNull();
  expect(
    await prisma.ledgerMember.findUnique({ where: { id: registeredMemberId(sharedId, target.id) } }),
  ).toMatchObject({ linkedAccountId: target.id, memberType: 'REGISTERED', status: 'ACTIVE' });
  expect(await prisma.syncChange.count({ where: { entityId: registeredMemberId(sharedId, target.id) } })).toBe(0);
});
