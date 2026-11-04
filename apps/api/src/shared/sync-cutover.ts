import type { Prisma, PrismaClient } from '@prisma/client';
import { ApiError } from './errors.js';

type CutoverSource = Pick<PrismaClient | Prisma.TransactionClient, '$queryRaw'>;
type SyncCutover = { cursor: bigint | null; cursorFloor: bigint };

/** 切点属于服务端持久事实，普通读写不会隐式创建或推进它。 */
async function readSyncCutover(prisma: CutoverSource): Promise<SyncCutover | null> {
  const [row] = await prisma.$queryRaw<SyncCutover[]>`
    SELECT sync_cutover_cursor AS cursor, sync_cursor_floor AS "cursorFloor"
    FROM server_epochs WHERE id = 0
  `;
  return row ?? null;
}

/** 当前同步协议要求数据库具有完整的持久切点。 */
export async function requireSyncCutover(prisma: CutoverSource): Promise<bigint> {
  return requireCompletedCutover(await readSyncCutover(prisma)).cursor;
}

/** 切点完成状态与持久下界一起读取，所有调用方共用相同的迁移拒绝条件。 */
function requireCompletedCutover(row: SyncCutover | null): SyncCutover & { cursor: bigint } {
  if (row === null || row.cursor === null) {
    throw new ApiError(
      503,
      'SYNC_PROTOCOL_MIGRATION_REQUIRED',
      '数据库同步状态未就绪，请联系管理员检查建库基线与部署日志',
    );
  }
  return { ...row, cursor: row.cursor };
}

/** 全局已提交水位包含协议切点和事件清理前保存的下界，保证已发布的完整快照游标不倒退。 */
export async function committedSyncCursor(
  prisma: Pick<PrismaClient | Prisma.TransactionClient, '$queryRaw' | 'syncChange'>,
): Promise<bigint> {
  try {
    const maximum = await prisma.syncChange.aggregate({ _max: { changeId: true } });
    const state = requireCompletedCutover(await readSyncCutover(prisma));
    if (typeof state.cursorFloor !== 'bigint' || state.cursorFloor < 0n) throw new Error('同步持久水位缺失或无效');
    let cursor = maximum._max.changeId ?? 0n;
    if (state.cursor > cursor) cursor = state.cursor;
    if (state.cursorFloor > cursor) cursor = state.cursorFloor;
    return cursor;
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw new Error('已提交同步水位读取失败', { cause });
  }
}
