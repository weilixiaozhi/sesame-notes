type SyncVersion = { updatedAt: Date; deviceId: string | null };

/** 比较 LWW 版本；设备 ID 作为稳定平局决胜项，保证所有节点得到相同结果。 */
export function compareSyncVersion(incoming: SyncVersion, current: SyncVersion): number {
  const timeDifference = incoming.updatedAt.getTime() - current.updatedAt.getTime();
  return timeDifference === 0 ? (incoming.deviceId ?? '').localeCompare(current.deviceId ?? '') : timeDifference;
}

/** 校验客户端时间并限制未来漂移，防止错误设备时钟长期压制正常更新。 */
export function normalizeClientTimestamp(value: string, now = new Date()): Date {
  try {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error('INVALID_TIMESTAMP');
    const latest = now.getTime() + 5_000;
    return parsed.getTime() > latest ? new Date(latest) : parsed;
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_TIMESTAMP') throw error;
    throw new Error('INVALID_TIMESTAMP', { cause: error });
  }
}
