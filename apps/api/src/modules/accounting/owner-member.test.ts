import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { normalizeName } from '../../shared/text-validation.js';
import { ensureOwnerMember } from './owner-member.js';

describe('账本所有者显示名快照', () => {
  it.each([`${'a'.repeat(63)}😀`, '😀'.repeat(64)])('合法 Unicode 昵称按完整码点保存：%s', async (name) => {
    try {
      expect(normalizeName(name)).toBe(name);
      const upsert = vi.fn().mockResolvedValue({});
      const tx = {
        user: { findUnique: async () => ({ profile: { displayName: name } }) },
        ledgerMember: { upsert },
      } as unknown as Prisma.TransactionClient;
      await ensureOwnerMember(tx, '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', {
        createdAt: new Date(0),
        updatedAt: new Date(0),
        updatedByDeviceId: null,
      });
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ displayName: name }) }),
      );
      expect(upsert.mock.calls[0]![0].create.displayName.isWellFormed()).toBe(true);
    } catch (cause) {
      throw new Error('所有者昵称快照 Unicode 边界验证失败', { cause });
    }
  });
});
