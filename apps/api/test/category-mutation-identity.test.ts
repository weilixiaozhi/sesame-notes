import { describe, expect, it, vi } from 'vitest';
import type { SyncTransaction } from '../src/shared/sync-transaction.js';
import { identifySyncMutation } from '../src/shared/sync-mutation.js';
import { findIdempotentReplay } from '../src/shared/idempotency.js';
import { reserveMutation } from '../src/shared/mutation-reservations.js';
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
  it('相同hash可以继续恢复，但设备及账号身份包含在永久回执读取中', async () => {
    const { model, tx } = fixture();
    model.mutationReservation.findUnique.mockResolvedValueOnce({ requestHash: hash });
    await expect(identifySyncMutation(tx, auth, change)).resolves.toMatchObject({ requestHash: hash, duplicate: null });
    expect(model.mutationReservation.findUnique).toHaveBeenCalledWith({
      where: {
        scope_userId_scopeId_mutationId: {
          scope: 'device',
          userId: auth.userId,
          scopeId: auth.deviceId,
          mutationId: change.mutation_id,
        },
      },
    });
  });
  it('无事件来源已占用的UUID不能用于另一实体不同payload', async () => {
    const { model, tx } = fixture();
    model.mutationReservation.findUnique.mockResolvedValueOnce({ requestHash: hash });
    const otherEntity = { ...change, entity_type: 'transaction' };
    await expect(identifySyncMutation(tx, auth, otherEntity)).rejects.toMatchObject({
      statusCode: 409,
      code: 'MUTATION_ID_REUSED',
    });
  });
  it('保留云端的确认虽无SyncChange，确认UUID仍不能再作为同步写入', async () => {
    const { model, tx } = fixture();
    model.mutationReservation.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ requestHash: 'command' });
    await expect(identifySyncMutation(tx, auth, change)).rejects.toMatchObject({ code: 'MUTATION_ID_REUSED' });
  });
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
      createdAt: new Date(0),
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
  it('永久来源回执hash不同不能伪装为已确认同一请求', async () => {
    const { model, tx } = fixture();
    deviceReceipt(model, 'other-request');
    await expect(
      guardCategoryWrite(
        tx,
        auth,
        {
          mutation_id: change.mutation_id,
          entity_id: 'category',
          action: 'delete',
          payload: {},
        },
        null,
        null,
        hash,
        new Date(0),
      ),
    ).rejects.toMatchObject({ code: 'MUTATION_ID_REUSED' });
  });
  it('原值校验不能让自定义分类通过非法base_token，普通无字段行为仍保留', async () => {
    const { tx } = fixture();
    const intent = {
      mutation_id: change.mutation_id,
      entity_id: 'custom',
      action: 'delete' as const,
      payload: { base_token: 123 },
    };
    await expect(guardCategoryWrite(tx, auth, intent, null, null, hash, new Date(0))).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_CATEGORY_BASE',
    });
    await expect(
      guardCategoryWrite(tx, auth, { ...intent, payload: {} }, null, null, hash, new Date(0)),
    ).resolves.toMatchObject({ kind: 'apply', updatedAt: new Date(0) });
  });
  it('永久占用保存账号及设备作用域，相同请求重放而不同指纹拒绝', async () => {
    const { model, tx } = fixture();
    await reserveMutation(tx, auth, change.mutation_id, hash);
    expect(model.mutationReservation.create).toHaveBeenCalledWith({
      data: {
        scope: 'device',
        userId: auth.userId,
        scopeId: auth.deviceId,
        mutationId: change.mutation_id,
        requestHash: hash,
      },
    });
    deviceReceipt(model, hash);
    await reserveMutation(tx, auth, change.mutation_id, hash);
    await expect(reserveMutation(tx, auth, change.mutation_id, 'different')).rejects.toMatchObject({
      code: 'MUTATION_ID_REUSED',
    });
    expect(model.mutationReservation.create).toHaveBeenCalledTimes(1);
    expect(model.categoryConflict.findFirst).not.toHaveBeenCalled();
  });
  it('REST分类意图不能把已有账号命令UUID变为新的来源', async () => {
    const { model, tx } = fixture();
    model.mutationReservation.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ requestHash: 'command' });
    await expect(
      guardCategoryWrite(
        tx,
        auth,
        {
          mutation_id: change.mutation_id,
          entity_id: 'category',
          action: 'delete',
          payload: {},
        },
        null,
        null,
        hash,
        new Date(),
      ),
    ).rejects.toMatchObject({ code: 'MUTATION_ID_REUSED' });
    expect(model.categoryConflict.findUnique).not.toHaveBeenCalled();
  });
  it.each(['reservation', 'event'])('账号命令不能事后占用另一设备已接受的来源：%s', async (kind) => {
    const { model, tx } = fixture();
    if (kind === 'reservation')
      model.mutationReservation.findFirst.mockResolvedValue({ mutationId: change.mutation_id });
    else model.syncChange.findFirst.mockResolvedValue({ mutationId: change.mutation_id });
    await expect(reserveMutation(tx, auth, change.mutation_id, 'command', 'account')).rejects.toMatchObject({
      code: 'MUTATION_ID_REUSED',
    });
    expect(model.mutationReservation.create).not.toHaveBeenCalled();
    expect(model.syncChange.findFirst).toHaveBeenCalledWith({
      where: { userId: auth.userId, mutationId: change.mutation_id },
      select: { mutationId: true },
    });
  });
});
