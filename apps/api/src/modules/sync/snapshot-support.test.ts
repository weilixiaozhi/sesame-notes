import { Prisma, type Ledger } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { SnapshotWriter } from '../../shared/snapshot-stream.js';
import { snapshotCatalogs, writeLedgerSnapshot } from './snapshot-support.js';

const ledger = {
  id: '11111111-1111-4111-8111-111111111111',
  ownerId: '22222222-2222-4222-8222-222222222222',
  syncId: '33333333-3333-4333-8333-333333333333',
  name: '快照测试',
  currency: 'CNY',
  monthStartDay: 1,
  aaEnabled: false,
  updatedAt: new Date(0),
} as Ledger;

/** 使用真实快照编排；输出替身只消费已构造内容，不涉及文件系统或数据库。 */
function fixture(members: () => Promise<unknown[]>, readRates: ReturnType<typeof vi.fn>) {
  const tx = {
    ledgerMember: { findMany: members },
    category: { findMany: async () => [] },
    exchangeRateOverride: { findMany: readRates },
  } as unknown as Prisma.TransactionClient;
  const writer = { text: async () => {}, value: async () => {}, array: async () => {} } as unknown as SnapshotWriter;
  const catalogs = snapshotCatalogs(tx, ledger.ownerId);
  return { catalogs, write: () => writeLedgerSnapshot(writer, tx, ledger, ledger.ownerId, {} as never, catalogs) };
}

describe('完整快照汇率查询生命周期', () => {
  it('前置步骤等待时不提前发起汇率读取，读取失败交由快照调用方捕获', async () => {
    try {
      const gate = Promise.withResolvers<unknown[]>();
      const cause = new Error('合成汇率读取失败');
      const readRates = vi.fn().mockRejectedValue(cause);
      const { write } = fixture(() => gate.promise, readRates);
      const writing = write();
      const rejected = expect(writing).rejects.toMatchObject({ message: '个人汇率目录读取失败', cause });
      // 跨过一轮事件循环，确保提前失败的 Promise 有机会暴露未处理拒绝。
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(readRates).not.toHaveBeenCalled();
      gate.resolve([]);
      await rejected;
      expect(readRates).toHaveBeenCalledOnce();
    } catch (cause) {
      throw new Error('快照汇率失败接管验证失败', { cause });
    }
  });

  it('前置查询失败时不创建无消费者的汇率查询', async () => {
    try {
      const cause = new Error('合成成员查询失败');
      const readRates = vi.fn().mockRejectedValue(new Error('不应查询汇率'));
      const { write } = fixture(async () => {
        throw cause;
      }, readRates);
      await expect(write()).rejects.toBe(cause);
      expect(readRates).not.toHaveBeenCalled();
    } catch (cause) {
      throw new Error('快照前置失败资源边界验证失败', { cause });
    }
  });

  it('同一快照中的重复汇率读取复用结果与规范金额', async () => {
    try {
      const readRates = vi.fn().mockResolvedValue([
        {
          id: ledger.id,
          baseCurrency: 'USD',
          quoteCurrency: 'CNY',
          rate: new Prisma.Decimal('7.20'),
          updatedAt: new Date(0),
        },
      ]);
      const { catalogs } = fixture(async () => [], readRates);
      const [first, second] = await Promise.all([catalogs.rates(), catalogs.rates()]);
      expect(first).toEqual([
        {
          id: ledger.id,
          base_currency: 'USD',
          quote_currency: 'CNY',
          rate: '7.2',
          updated_at: new Date(0).toISOString(),
        },
      ]);
      expect(second).toEqual(first);
      expect(readRates).toHaveBeenCalledOnce();
    } catch (cause) {
      throw new Error('快照汇率结果复用验证失败', { cause });
    }
  });
});
