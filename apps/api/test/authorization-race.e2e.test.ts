import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '@prisma/client';
import { randomInt, randomUUID } from 'node:crypto';

import {
  ensureOwnerMember,
  getLedgerReadAccess,
  getLedgerWriteAccess,
  registeredMemberId,
} from '../src/modules/accounting/index.js';
import { deleteAccount } from '../src/modules/accounts/index.js';
import { withSyncTransaction } from '../src/shared/sync-transaction.js';

const DATABASE_URL = testFixtureDatabaseUrl();

let prisma: PrismaClient;

beforeAll(() => {
  prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('账本撤权与写入串行化', () => {
  it('完整快照的读授权不阻塞同账本写事务，且读视图保持一致', async () => {
    const ownerId = randomUUID();
    const ledgerId = randomUUID();
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let snapshot: Promise<string> | undefined;
    try {
      await prisma.user.create({
        data: {
          id: ownerId,
          phoneE164: `+86138${randomInt(100000000).toString().padStart(8, '0')}`,
          sesameNumber: randomInt(100000000, 1000000000).toString(),
          passwordHash: 'read-snapshot-test',
        },
      });
      await prisma.$transaction(async (tx) => {
        const ledger = await tx.ledger.create({
          data: { id: ledgerId, ownerId, syncId: randomUUID(), name: '快照起始名称', currency: 'CNY' },
        });
        await ensureOwnerMember(tx, ledgerId, ownerId, ledger);
      });
      snapshot = prisma.$transaction(
        async (tx) => {
          await getLedgerReadAccess(tx, ownerId, ledgerId, 'editor');
          ready.resolve();
          // 保持快照事务未结束，模拟完整快照分页或写文件期间的数据库视图。
          await release.promise;
          return (await tx.ledger.findUniqueOrThrow({ where: { id: ledgerId } })).name;
        },
        { isolationLevel: 'RepeatableRead', timeout: 10_000 },
      );
      void snapshot.catch(ready.reject);
      await ready.promise;
      await withSyncTransaction(prisma, async (tx) => {
        // 若读授权错误持有行锁，数据库会明确报锁等待超时，避免测试依赖任意 sleep 时序。
        await tx.$executeRaw`SET LOCAL lock_timeout = '1500ms'`;
        await getLedgerWriteAccess(tx, ownerId, ledgerId, 'owner');
        await tx.ledger.update({ where: { id: ledgerId }, data: { name: '并发写入名称' } });
      });
      release.resolve();
      expect(await snapshot).toBe('快照起始名称');
      expect((await prisma.ledger.findUniqueOrThrow({ where: { id: ledgerId } })).name).toBe('并发写入名称');
    } catch (cause) {
      throw new Error('账本只读快照阻塞写入或丢失一致视图', { cause });
    } finally {
      release.resolve();
      await Promise.allSettled(snapshot ? [snapshot] : []);
      await deleteAccount(prisma, ownerId);
    }
  });

  it('撤权先取得成员行锁时，并发旧请求等待提交后必须拒绝写入', async () => {
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const ledgerId = randomUUID();
    const transactionId = randomUUID();
    let releaseRevocation!: () => void;
    let markRevocationReady!: () => void;
    const revocationReady = new Promise<void>((resolve) => (markRevocationReady = resolve));
    const revocationGate = new Promise<void>((resolve) => (releaseRevocation = resolve));
    let revocationPid: number;

    await prisma.user.createMany({
      data: [ownerId, memberId].map((id, index) => ({
        id,
        phoneE164: `+86139${id.replace(/\D/g, '').slice(0, 8)}`,
        sesameNumber: `${700000000 + Number(id.replace(/\D/g, '').slice(0, 8) || index)}`.slice(0, 9),
        passwordHash: 'test-password-hash',
      })),
    });
    await prisma.$transaction(async (tx) => {
      await tx.ledger.create({
        data: { id: ledgerId, syncId: randomUUID(), ownerId, name: '并发撤权测试', currency: 'CNY' },
      });
      await tx.ledgerMember.createMany({
        data: [
          {
            id: registeredMemberId(ledgerId, ownerId),
            ledgerId,
            displayName: 'Owner',
            memberType: 'REGISTERED',
            linkedAccountId: ownerId,
            role: 'owner',
            status: 'ACTIVE',
          },
          {
            id: registeredMemberId(ledgerId, memberId),
            ledgerId,
            displayName: '成员',
            memberType: 'REGISTERED',
            linkedAccountId: memberId,
            role: 'editor',
            status: 'ACTIVE',
          },
        ],
      });
    });

    const revocation = prisma.$transaction(
      async (tx) => {
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        revocationPid = backend!.pid;
        await tx.ledgerMember.update({
          where: { ledgerId_linkedAccountId: { ledgerId, linkedAccountId: memberId } },
          data: { status: 'REMOVED' },
        });
        markRevocationReady();
        await revocationGate;
      },
      { timeout: 10_000 },
    );
    await revocationReady;

    const write = prisma.$transaction(
      async (tx) => {
        await getLedgerWriteAccess(tx, memberId, ledgerId, 'editor');
        await tx.transaction.create({
          data: {
            id: transactionId,
            ledgerId,
            ownerId,
            txType: 'expense',
            amount: '1',
            happenedAt: new Date(),
            currencyCode: 'CNY',
            nativeAmount: '1',
          },
        });
      },
      { timeout: 10_000 },
    );
    // 提前接收拒绝结果，等待锁队列失败时也能释放锁并排空两个事务。
    const writeOutcome = write.then(
      () => ({ status: 'fulfilled' }) as const,
      (reason: unknown) => ({ status: 'rejected', reason }) as const,
    );

    try {
      // 只在请求已被撤权事务阻塞于成员行锁之后提交撤权，确保真实覆盖等待中的旧授权。
      await expect
        .poll(
          async () => {
            const [state] = await prisma.$queryRaw<Array<{ waiting: boolean }>>`
              SELECT EXISTS (
                SELECT 1
                FROM pg_stat_activity
                WHERE datname = current_database()
                  AND pid <> pg_backend_pid()
                  AND wait_event_type = 'Lock'
                  AND ${revocationPid!}::integer = ANY(pg_blocking_pids(pid))
                  AND query ILIKE '%ledger_members%'
              ) AS "waiting"
            `;
            return state?.waiting ?? false;
          },
          { timeout: 2_000, interval: 20 },
        )
        .toBe(true);
    } catch (cause) {
      throw new Error('撤权请求等待成员锁的真实并发边界验证失败', { cause });
    } finally {
      releaseRevocation();
      await Promise.allSettled([revocation, writeOutcome]);
    }
    await revocation;
    expect(await writeOutcome).toMatchObject({ status: 'rejected', reason: { code: 'LEDGER_NOT_FOUND' } });
    await expect(prisma.transaction.findUnique({ where: { id: transactionId } })).resolves.toBeNull();
  });
});
