import { describe, expect, it, vi } from 'vitest';
import type { SyncTransaction } from '../src/shared/sync-transaction.js';

import { findIdempotentReplay } from '../src/shared/idempotency.js';

import { requestFingerprint } from '../src/shared/request-fingerprint.js';
import { guardCategoryWrite } from '../src/modules/accounting/testing.js';
import type { Category } from '@prisma/client';

const auth = { userId: 'owner', deviceId: 'device' };
const change = { mutation_id: 'mutation', entity_type: 'category', payload: { name: '相同内容' } };
const hash = requestFingerprint({ ...change, user_id: auth.userId });
/** 只模拟明确读取的身份记录，不把未知数据库请求笼统返回空。 */
function fixture() {
  const model = {
    syncChange: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null) },
    categoryConflict: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue(null) },
    mutationReservation: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
  };
  return { model, tx: model as unknown as SyncTransaction };
}

/** 设备来源占用不应同时伪造出账号命令占用。 */
function deviceReceipt(model: ReturnType<typeof fixture>['model'], requestHash: string): void {
  model.mutationReservation.findUnique.mockImplementation(
    ({ where }: { where: { scope_userId_scopeId_mutationId: { scope: string } } }) =>
      Promise.resolve(where.scope_userId_scopeId_mutationId.scope === 'device' ? { requestHash } : null),
  );
}

describe('分类无事件回执的全局mutation身份', () => {
  it('普通REST缓存不得读取或删除内部来源占位，不查询generation也不改记录', async () => {
    const { tx } = fixture();
    await expect(
      findIdempotentReplay(tx, auth.userId, 'category-source:device:mutation', hash, new Date()),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_IDEMPOTENCY_KEY' });
  });
  it('永久无变更回执不随缓存generation轮换重新应用旧意图', async () => {
    const { model, tx } = fixture();
    deviceReceipt(model, hash);
    const current = {
      id: '11111111-1111-5111-8111-111111111111',
      ownerId: auth.userId,
      name: '之后另端改名',
      kind: 'expense',
      level: 1,
      parentId: null,
      sortOrder: 0,
      icon: null,
      updatedAt: new Date(1000),
      updatedByDeviceId: 'other',
      deletedAt: null,
    } satisfies Category;
    const outcome = await guardCategoryWrite(
      tx,
      auth,
      {
        mutation_id: change.mutation_id,
        entity_id: current.id,
        action: 'upsert',
        payload: { name: '旧名称' },
      },
      current,
      null,
      hash,
      new Date(0),
    );
    expect(outcome).toMatchObject({ kind: 'accepted', state: { name: current.name } });
  });
});
