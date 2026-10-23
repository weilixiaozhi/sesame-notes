import type { PrismaClient } from '@prisma/client';
import { expect, it, vi } from 'vitest';
import { deleteAccount } from './account-deletion.js';

it('账号注销给协作者留下独立的账本归属和删除时间，不依赖已删除账号的外键', async () => {
  try {
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const peerId = '22222222-2222-4222-8222-222222222222';
    const ledgerId = '33333333-3333-4333-8333-333333333333';
    const deletedAt = new Date('2026-10-20T00:00:00.000Z');
    const create = vi.fn(async () => ({ changeId: 1n }));
    const removeUser = vi.fn(async () => ({}));
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(async () => [{ id: ownerId }]),
      ledger: {
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => [{ id: ledgerId, deletedAt, members: [{ linkedAccountId: peerId }] }]),
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
      device: { findFirst: vi.fn(async () => ({ id: ownerId })) },
      syncChange: { deleteMany: vi.fn(async () => ({ count: 0 })), create },
      ledgerMember: { findMany: vi.fn(async () => []) },
      user: { delete: removeUser },
    };
    const prisma = { $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx) };
    await expect(deleteAccount(prisma as unknown as PrismaClient, ownerId)).resolves.toEqual({
      deleted: true,
      detachedMembers: 0,
    });
    expect(create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        entityType: 'ledger',
        entityId: ledgerId,
        action: 'delete',
        ledgerId: null,
        recipientUserId: peerId,
        updatedAt: deletedAt,
        payload: { owner_id: ownerId, deleted_at: deletedAt.toISOString() },
      }),
    });
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(removeUser.mock.invocationCallOrder[0]!);
  } catch (cause) {
    throw new Error('注销账号的协作者账本墓碑契约验证失败', { cause });
  }
});
