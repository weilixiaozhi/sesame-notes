import type { MutationReservationScope } from '@prisma/client';
import type { SyncTransaction } from './sync-transaction.js';
import { ApiError } from './errors.js';

type MutationIdentity = { userId: string; deviceId: string };

/** 读取没有同步事件的永久占用，账号范围覆盖同账号全部设备。 */
export async function findMutationReservation(
  tx: SyncTransaction,
  auth: MutationIdentity,
  mutationId: string,
  scope: MutationReservationScope,
) {
  try {
    return await tx.mutationReservation.findUnique({
      where: {
        scope_userId_scopeId_mutationId: {
          scope,
          userId: auth.userId,
          scopeId: scope === 'account' ? auth.userId : auth.deviceId,
          mutationId,
        },
      },
    });
  } catch (cause) {
    throw new Error('同步请求身份读取失败', { cause });
  }
}

/** 所有入口共用事件、设备占用与账号占用校验，防止 REST 绕过同步身份域。 */
export async function checkMutationIdentity(
  tx: SyncTransaction,
  auth: MutationIdentity,
  mutationId: string,
  requestHash: string,
) {
  try {
    const duplicate = await tx.syncChange.findUnique({
      where: { deviceId_mutationId: { deviceId: auth.deviceId, mutationId } },
    });
    if (duplicate && (duplicate.userId !== auth.userId || duplicate.requestHash !== requestHash))
      throw new ApiError(409, 'MUTATION_ID_REUSED', '该请求标识已用于不同同步请求');
    const deviceReservation = await findMutationReservation(tx, auth, mutationId, 'device');
    if (deviceReservation && deviceReservation.requestHash !== requestHash)
      throw new ApiError(409, 'MUTATION_ID_REUSED', '该请求标识已用于不同同步请求');
    if (await findMutationReservation(tx, auth, mutationId, 'account'))
      throw new ApiError(409, 'MUTATION_ID_REUSED', '该请求标识已用于账号级操作');
    return { duplicate, deviceReservation };
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw new Error('统一同步请求身份校验失败', { cause });
  }
}

/** 在同步提交锁内永久保留成功意图的身份；相同请求可重放，不同指纹必须拒绝。 */
export async function reserveMutation(
  tx: SyncTransaction,
  auth: MutationIdentity,
  mutationId: string,
  requestHash: string,
  scope: MutationReservationScope = 'device',
): Promise<void> {
  try {
    const existing =
      scope === 'device'
        ? (await checkMutationIdentity(tx, auth, mutationId, requestHash)).deviceReservation
        : await findMutationReservation(tx, auth, mutationId, scope);
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new ApiError(409, 'MUTATION_ID_REUSED', '该请求标识已用于不同操作');
      return;
    }
    if (scope === 'account') {
      // 账号级命令覆盖所有设备，不能事后占用另一设备已经接受的来源身份。
      const source = await tx.mutationReservation.findFirst({
        where: { scope: 'device', userId: auth.userId, mutationId },
        select: { mutationId: true },
      });
      const event = await tx.syncChange.findFirst({
        where: { userId: auth.userId, mutationId },
        select: { mutationId: true },
      });
      if (source || event) throw new ApiError(409, 'MUTATION_ID_REUSED', '该请求标识已被账号内其他同步操作占用');
    }
    await tx.mutationReservation.create({
      data: {
        scope,
        userId: auth.userId,
        scopeId: scope === 'account' ? auth.userId : auth.deviceId,
        mutationId,
        requestHash,
      },
    });
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw new Error('同步请求身份保存失败', { cause });
  }
}
