import type { AppBanner, Prisma, PrismaClient } from '@prisma/client';
import { ApiError } from '../../shared/errors.js';
import { MAX_BANNER_SLIDES_PER_SLOT, type BannerCreate, type BannerSlot } from './banner-schemas.js';

type BannerDatabase = Pick<
  PrismaClient | Prisma.TransactionClient,
  'appBanner' | 'appBannerMedia' | 'officialFitnessContent'
>;
export const activeBannerWhere = { deletedAt: null, isEnabled: true } as const;
export const bannerOrder = [{ slot: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }] as const;

/** 官方内容名称按三语言明确读取，目录中的无效资料不能生成可点击目标。 */
export function officialBannerName(content: Prisma.JsonValue): { zh: string; zh_hant: string; en: string } | null {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const name = content.name;
  if (!name || typeof name !== 'object' || Array.isArray(name)) return null;
  if (typeof name.zh !== 'string' || typeof name.zh_hant !== 'string' || typeof name.en !== 'string') return null;
  return { zh: name.zh, zh_hant: name.zh_hant, en: name.en };
}

/** 使用一次批量查询取得详情目标名称，可选过滤停用目标以避免给客户端发送失效入口。 */
export async function bannerTargetNames(db: BannerDatabase, rows: AppBanner[], enabledOnly = false) {
  try {
    const ids = [...new Set(rows.flatMap((row) => (row.targetId ? [row.targetId] : [])))];
    if (!ids.length) return new Map<string, string>();
    const contents = await db.officialFitnessContent.findMany({
      where: { id: { in: ids }, kind: { in: ['plan', 'template'] }, ...(enabledOnly ? { isEnabled: true } : {}) },
      select: { id: true, kind: true, content: true },
    });
    const names = new Map<string, string>();
    for (const content of contents) {
      const name = officialBannerName(content.content);
      if (name) names.set(`official-${content.kind}:${content.id}`, name.zh);
    }
    return names;
  } catch (cause) {
    throw new Error('读取 Banner 官方目标名称失败', { cause });
  }
}

/** 每张自定义图片独立携带身份、目标和修订号，排序相同按稳定身份确定展示顺序。 */
export function bannerSlideResponse(row: AppBanner, names: ReadonlyMap<string, string>) {
  return {
    id: row.id,
    slot: row.slot,
    image_path: row.imageId ? `/api/v1/banners/media/${row.imageId}` : null,
    target: row.target,
    target_id: row.targetId,
    target_name: row.targetId ? (names.get(`${row.target}:${row.targetId}`) ?? null) : null,
    version: row.version,
    sort_order: row.sortOrder,
  };
}

/** 管理表格按位置显示虚拟默认行；默认图片属于应用资源，不持久化为可删除记录。 */
export function builtinBannerResponse(slot: BannerSlot) {
  return {
    id: `builtin:${slot}`,
    slot,
    image_path: null,
    target: slot,
    target_id: null,
    target_name: null,
    version: 0,
    sort_order: 0,
    source: 'builtin' as const,
    updated_at: null,
    updated_by: null,
  };
}

/** 管理员资料只随管理响应返回，不进入匿名客户端配置。 */
export function adminBannerResponse(row: AppBanner, names: ReadonlyMap<string, string>) {
  return {
    ...bannerSlideResponse(row, names),
    source: 'remote' as const,
    updated_at: row.updatedAt.toISOString(),
    updated_by: row.updatedBy,
  };
}

/** 在写事务中核对图片和详情目标，避免把不存在或停用的官方内容配置成入口。 */
export async function validateBannerContent(db: BannerDatabase, body: BannerCreate): Promise<void> {
  try {
    if (!(await db.appBannerMedia.findUnique({ where: { id: body.image_id } })))
      throw new ApiError(400, 'BANNER_MEDIA_NOT_FOUND', '所选图片不存在，请重新上传');
    if (body.target === 'official-plan' || body.target === 'official-template') {
      if (!body.target_id) throw new ApiError(400, 'BANNER_TARGET_REQUIRED', '请选择要打开的训练计划或模板');
      const target = await db.officialFitnessContent.findUnique({ where: { id: body.target_id } });
      if (
        !target ||
        !target.isEnabled ||
        `official-${target.kind}` !== body.target ||
        !officialBannerName(target.content)
      )
        throw new ApiError(400, 'BANNER_TARGET_UNAVAILABLE', '所选训练计划或模板不存在或已停用，请重新选择');
    } else if (body.target_id !== null) {
      throw new ApiError(400, 'BANNER_TARGET_INVALID', '此跳转位置不需要指定训练内容');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('Banner 图片与跳转目标校验失败', { cause: error });
  }
}

/** 同一位置图片数量保持有界，移动图片时只计算目标位置其他有效记录。 */
export async function assertBannerCapacity(db: BannerDatabase, slot: BannerSlot, exceptId?: string): Promise<void> {
  try {
    const count = await db.appBanner.count({
      where: { ...activeBannerWhere, slot, ...(exceptId ? { id: { not: exceptId } } : {}) },
    });
    if (count >= MAX_BANNER_SLIDES_PER_SLOT)
      throw new ApiError(400, 'BANNER_LIMIT_REACHED', `每个位置最多配置 ${MAX_BANNER_SLIDES_PER_SLOT} 张图片`);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('读取 Banner 位置图片数量失败', { cause: error });
  }
}

/** 乐观锁只匹配有效图片，已经删除或被其他管理员修改的行不能被覆盖。 */
export async function editableBanner(db: BannerDatabase, id: string, version: number): Promise<AppBanner> {
  try {
    const row = await db.appBanner.findUnique({ where: { id } });
    if (!row || row.deletedAt !== null || !row.isEnabled)
      throw new ApiError(404, 'BANNER_NOT_FOUND', '这张图片已移除，请刷新后重试');
    if (row.version !== version)
      throw new ApiError(409, 'BANNER_VERSION_CONFLICT', '图片配置已被其他管理员修改，请刷新后重试');
    return row;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('读取 Banner 图片版本失败', { cause: error });
  }
}
