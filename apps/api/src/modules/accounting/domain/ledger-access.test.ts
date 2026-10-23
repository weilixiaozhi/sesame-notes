import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { getLedgerReadAccess, getLedgerWriteAccess } from './ledger-access.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const editorId = '22222222-2222-4222-8222-222222222222';
const ledgerId = '33333333-3333-4333-8333-333333333333';

/** 构造不含根客户端事务方法的替身，模拟真实只读事务收到的 Prisma TransactionClient。 */
function transactionClient() {
  const queryRaw = vi.fn();
  const findFirst = vi.fn();
  const findUnique = vi.fn();
  const tx = { $queryRaw: queryRaw, ledger: { findFirst, findUnique } } as unknown as Prisma.TransactionClient;
  return { tx, queryRaw, findFirst, findUnique };
}

describe('账本读授权与写锁边界', () => {
  it('只读事务使用快照授权，不因缺少根客户端方法而取得行锁', async () => {
    try {
      const client = transactionClient();
      const ledger = { id: ledgerId, ownerId, members: [], deletedAt: null };
      client.findFirst.mockResolvedValue(ledger);
      expect(await getLedgerReadAccess(client.tx, ownerId, ledgerId, 'owner')).toEqual({
        ledger: { id: ledgerId, ownerId, deletedAt: null },
        role: 'owner',
      });
      expect(client.queryRaw).not.toHaveBeenCalled();
      expect(client.findFirst).toHaveBeenCalledWith({
        where: {
          id: ledgerId,
          deletedAt: null,
          OR: [
            { ownerId },
            { members: { some: { linkedAccountId: ownerId, status: 'ACTIVE', memberType: 'REGISTERED' } } },
          ],
        },
        include: {
          members: { where: { linkedAccountId: ownerId, status: 'ACTIVE', memberType: 'REGISTERED' }, take: 1 },
        },
      });
    } catch (cause) {
      throw new Error('只读账本权限边界验证失败', { cause });
    }
  });

  it('无锁读取仍拒绝非成员及权限不足的编辑者', async () => {
    try {
      const client = transactionClient();
      client.findFirst.mockResolvedValueOnce(null);
      await expect(getLedgerReadAccess(client.tx, editorId, ledgerId, 'editor')).rejects.toMatchObject({
        statusCode: 404,
        code: 'LEDGER_NOT_FOUND',
      });
      client.findFirst.mockResolvedValue({ id: ledgerId, ownerId, members: [{ role: 'editor' }], deletedAt: null });
      await expect(getLedgerReadAccess(client.tx, editorId, ledgerId, 'owner')).rejects.toMatchObject({
        statusCode: 403,
        code: 'LEDGER_PERMISSION_DENIED',
      });
      expect(client.queryRaw).not.toHaveBeenCalled();
    } catch (cause) {
      throw new Error('只读账本权限拒绝验证失败', { cause });
    }
  });

  it('写授权按账本再成员顺序持锁，撤权后的成员不可继续读取并写入', async () => {
    try {
      const client = transactionClient();
      client.queryRaw.mockResolvedValueOnce([{ id: ledgerId, ownerId }]).mockResolvedValueOnce([]);
      await expect(getLedgerWriteAccess(client.tx, editorId, ledgerId, 'editor')).rejects.toMatchObject({
        statusCode: 404,
        code: 'LEDGER_NOT_FOUND',
      });
      const statements = client.queryRaw.mock.calls.map(([parts]) => (parts as TemplateStringsArray).join('?'));
      expect(statements).toHaveLength(2);
      expect(statements[0]).toMatch(/FROM "ledgers"[\s\S]*FOR UPDATE/);
      expect(statements[1]).toMatch(/FROM "ledger_members"[\s\S]*"status" = 'ACTIVE'[\s\S]*FOR UPDATE/);
      expect(client.findUnique).not.toHaveBeenCalled();
    } catch (cause) {
      throw new Error('账本写授权撤权边界验证失败', { cause });
    }
  });

  it('锁内权限读取异常保留根因，不能被误判为用户无权限', async () => {
    try {
      const client = transactionClient();
      const cause = new Error('database unavailable');
      client.queryRaw.mockRejectedValue(cause);
      await expect(getLedgerWriteAccess(client.tx, ownerId, ledgerId, 'owner')).rejects.toMatchObject({
        message: '账本写权限锁定失败',
        cause,
      });
    } catch (cause) {
      throw new Error('账本授权错误上下文验证失败', { cause });
    }
  });
});
