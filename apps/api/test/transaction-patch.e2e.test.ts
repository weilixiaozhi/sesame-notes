import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadTestApiConfig } from './test-api-config.js';

const DATABASE_URL = testFixtureDatabaseUrl();

let prisma: PrismaClient;
let app: ReturnType<typeof buildApp>;
let token: string | undefined;

type TransactionFixture = { ledgerId: string; transactionId: string; memberId: string };

/** 通过真实 REST 接口访问测试账号，保留响应错误供断言定位。 */
async function api(method: 'POST' | 'PATCH', path: string, payload: Record<string, unknown>) {
  try {
    return await app.inject({
      method,
      url: `/api/v1${path}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload,
    });
  } catch (error) {
    console.error('交易部分更新测试请求失败', { method, path, error });
    throw error;
  }
}

beforeAll(async () => {
  try {
    prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
    app = buildApp({
      logger: false,
      prisma,
      config: {
        ...loadTestApiConfig(),
        databaseUrl: DATABASE_URL,
        storagePath: resolve(import.meta.dirname, '../../../Temp/transaction-patch'),
        rateLimitMax: 1000,
        authRateLimitMax: 1000,
      },
    });
    await app.ready();
    const registered = await api('POST', '/auth/register', {
      country_code: '+86',
      phone: `139${randomInt(0, 100_000_000).toString().padStart(8, '0')}`,
      password: 'password-123456',
      device: { installation_id: randomUUID(), name: 'AA 部分更新测试', platform: 'test' },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    token = registered.json<{ access_token: string }>().access_token;
  } catch (error) {
    console.error('交易部分更新测试初始化失败', error);
    throw error;
  }
});

afterAll(async () => {
  try {
    if (app) await app.close();
    else if (prisma) await prisma.$disconnect();
  } catch (error) {
    console.error('交易部分更新测试连接清理失败', error);
    throw error;
  }
});

/** 每个用例创建独立账本与交易，避免随机测试顺序共享 revision 或分摊状态。 */
async function createTransaction(custom: boolean): Promise<TransactionFixture> {
  try {
    const ledgerId = randomUUID();
    const ledger = await api('POST', '/ledgers', {
      id: ledgerId,
      name: 'AA 更新校验',
      currency: 'CNY',
      aa_enabled: true,
    });
    expect(ledger.statusCode, ledger.body).toBe(201);
    const member = await prisma.ledgerMember.findFirstOrThrow({ where: { ledgerId, role: 'owner' } });
    const transactionId = randomUUID();
    const created = await api('POST', `/ledgers/${ledgerId}/transactions`, {
      id: transactionId,
      tx_type: 'expense',
      amount: '100',
      native_amount: '100',
      currency_code: 'CNY',
      happened_at: '2026-09-27T00:00:00.000Z',
      aa_mode: custom ? '2' : '0',
      splits: custom ? [{ member_id: member.id, amount: '100' }] : [],
    });
    expect(created.statusCode, created.body).toBe(201);
    return { ledgerId, transactionId, memberId: member.id };
  } catch (error) {
    console.error('交易部分更新测试数据创建失败', error);
    throw error;
  }
}

/** 读取交易完整行、分摊、编辑历史及账本事件，验证拒绝请求没有任何持久化副作用。 */
async function readState(fixture: TransactionFixture) {
  try {
    const [transaction, changes] = await Promise.all([
      prisma.transaction.findUniqueOrThrow({
        where: { id: fixture.transactionId },
        include: { splits: { orderBy: { memberId: 'asc' } }, editHistory: { orderBy: { version: 'asc' } } },
      }),
      prisma.syncChange.findMany({ where: { ledgerId: fixture.ledgerId }, orderBy: { changeId: 'asc' } }),
    ]);
    return { transaction, changes };
  } catch (error) {
    console.error('交易部分更新测试状态读取失败', { fixture, error });
    throw error;
  }
}

type RejectedPatchCase = {
  name: string;
  custom: boolean;
  patch: (fixture: TransactionFixture) => Record<string, unknown>;
  code: string;
};

const rejectedPatches: RejectedPatchCase[] = [
  {
    name: '指定分摊修改金额时保留旧分摊导致总额不符',
    custom: true,
    patch: () => ({ amount: '200', native_amount: '200' }),
    code: 'AA_SPLIT_TOTAL_MISMATCH',
  },
  {
    name: '普通交易切换指定分摊时缺少分摊行',
    custom: false,
    patch: () => ({ aa_mode: '2' }),
    code: 'AA_SPLITS_REQUIRED',
  },
  {
    name: '切换人均模式但未清空已有指定分摊',
    custom: true,
    patch: () => ({ aa_mode: '0' }),
    code: 'AA_SPLITS_NOT_ALLOWED',
  },
  {
    name: '切换不分摊模式但未清空已有指定分摊',
    custom: true,
    patch: () => ({ aa_mode: '1' }),
    code: 'AA_SPLITS_NOT_ALLOWED',
  },
  {
    name: '清空 AA 模式但保留已有指定分摊',
    custom: true,
    patch: () => ({ aa_mode: null }),
    code: 'AA_SPLITS_NOT_ALLOWED',
  },
  {
    name: '显式分摊总额不符返回业务错误',
    custom: true,
    patch: ({ memberId }) => ({ splits: [{ member_id: memberId, amount: '99' }] }),
    code: 'AA_SPLIT_TOTAL_MISMATCH',
  },
  {
    name: '指定分摊不能显式清空分摊行',
    custom: true,
    patch: () => ({ splits: null }),
    code: 'AA_SPLITS_REQUIRED',
  },
  {
    name: '显式分摊参与人重复返回业务错误',
    custom: true,
    patch: ({ memberId }) => ({
      splits: [
        { member_id: memberId, amount: '50' },
        { member_id: memberId, amount: '50' },
      ],
    }),
    code: 'DUPLICATE_AA_PARTICIPANT',
  },
];

describe('REST 交易部分更新的完整 AA 不变量', () => {
  it.each(rejectedPatches)('$name：400 且完整状态保持不变', async ({ custom, patch, code }) => {
    try {
      const fixture = await createTransaction(custom);
      const before = await readState(fixture);
      const response = await api('PATCH', `/ledgers/${fixture.ledgerId}/transactions/${fixture.transactionId}`, {
        ...patch(fixture),
        base_revision: 1,
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ code });
      expect(await readState(fixture)).toEqual(before);
    } catch (error) {
      console.error('非法 AA 部分更新回归验证失败', { code, error });
      throw error;
    }
  });

  it('仅改备注保留分摊；金额与分摊一并修改可提交，旧 revision 冲突仍不写入', async () => {
    try {
      const fixture = await createTransaction(true);
      const path = `/ledgers/${fixture.ledgerId}/transactions/${fixture.transactionId}`;
      const before = await readState(fixture);
      const noted = await api('PATCH', path, { note: '仅修改备注', base_revision: 1 });
      expect(noted.statusCode, noted.body).toBe(200);
      const afterNote = await readState(fixture);
      expect(afterNote.transaction).toMatchObject({ note: '仅修改备注', revision: 2, aaMode: 2 });
      expect(afterNote.transaction.splits).toEqual(before.transaction.splits);
      expect(afterNote.transaction.editHistory).toHaveLength(1);
      expect(afterNote.changes).toHaveLength(before.changes.length + 1);

      const corrected = await api('PATCH', path, {
        amount: '200',
        native_amount: '200',
        splits: [{ member_id: fixture.memberId, amount: '200' }],
        base_revision: 2,
      });
      expect(corrected.statusCode, corrected.body).toBe(200);
      expect(corrected.json()).toMatchObject({ amount: '200', native_amount: '200', aa_mode: '2', revision: 3 });
      const afterCorrection = await readState(fixture);
      expect(afterCorrection.transaction.splits).toHaveLength(1);
      expect(afterCorrection.transaction.splits[0]!.amount.toString()).toBe('200');
      expect(afterCorrection.transaction.editHistory).toHaveLength(2);
      expect(afterCorrection.changes).toHaveLength(before.changes.length + 2);

      const stale = await api('PATCH', path, { note: '旧版本修改', base_revision: 2 });
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'SYNC_CONFLICT', details: { current_revision: 3 } });
      expect(await readState(fixture)).toEqual(afterCorrection);

      const cleared = await api('PATCH', path, { aa_mode: '0', splits: [], base_revision: 3 });
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(cleared.json()).toMatchObject({ aa_mode: '0', splits: [], revision: 4 });
      const afterClear = await readState(fixture);
      expect(afterClear.transaction.splits).toHaveLength(0);
      expect(afterClear.transaction.editHistory).toHaveLength(3);
      expect(afterClear.changes).toHaveLength(before.changes.length + 3);
    } catch (error) {
      console.error('有效 AA 部分更新与并发冲突回归验证失败', error);
      throw error;
    }
  });
});
