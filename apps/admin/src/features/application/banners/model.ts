import type { api } from '../../../api/client';
import { bannerImagePathSchema } from '../../../api/banner-contracts';

export type BannerEntry = Awaited<ReturnType<typeof api.adminBanners.list>>['items'][number];
export type BannerTarget = BannerEntry['target'];
export type BannerSlot = BannerEntry['slot'];
export type BannerStatistics = Awaited<ReturnType<typeof api.adminBanners.statistics>>;
export const bannerSlots = {
  'fitness-plan-library': { title: '计划页 · 计划库入口', image: '/banner-defaults/plan-library.png' },
  'fitness-template-library': { title: '模板页 · 模板库入口', image: '/banner-defaults/template-library.png' },
};
export const bannerTargets: Record<BannerTarget, string> = {
  'fitness-plan-library': '计划库',
  'fitness-template-library': '模板库',
  'fitness-exercises': '动作库',
  'fitness-plans': '我的计划',
  'fitness-templates': '我的模板',
  'official-plan': '指定官方计划',
  'official-template': '指定官方模板',
};

/** 仅从服务端受控素材地址提取标识，外站链接不能进入管理预览。 */
export function bannerImageId(path: string | null): string | null {
  if (path === null) return null;
  try {
    return bannerImagePathSchema.parse(path).split('/').at(-1)!;
  } catch {
    throw new Error('Banner 图片地址无效');
  }
}

/** 自定义图片使用鉴权预览，默认内容与客户端内置素材一致。 */
export function bannerPreview(entry: BannerEntry): string {
  const id = entry.source === 'remote' ? bannerImageId(entry.image_path) : null;
  return id ? `/api/v1/admin/banners/media/${id}` : bannerSlots[entry.slot].image;
}

/** 内置入口只用于预览和离线回退，不作为可删除的自定义图片。 */
export function builtinBanner(slot: BannerSlot): BannerEntry {
  return {
    id: `builtin:${slot}`,
    slot,
    source: 'builtin',
    version: 0,
    image_path: null,
    target: slot,
    target_id: null,
    target_name: null,
    sort_order: 0,
    updated_at: null,
    updated_by: null,
  };
}

/** 官方详情展示可理解的内容名称，其他入口显示已注册页面名称。 */
export function bannerTargetLabel(entry: BannerEntry): string {
  return entry.target_id
    ? `${bannerTargets[entry.target]} · ${entry.target_name || '内容已不可用'}`
    : bannerTargets[entry.target];
}

/** 只展示与当前图片及跳转配置匹配的统计，防止两次请求跨越修改时串用旧数据。 */
export function currentBannerMetrics(entry: BannerEntry, report?: BannerStatistics) {
  const source = entry.source;
  const version = source === 'remote' ? entry.version : 0;
  return report?.items.find(
    (item) =>
      item.banner_id === entry.id && item.slot === entry.slot && item.source === source && item.version === version,
  );
}

/** 尚未覆盖的零值保留为空，真实事件或完整覆盖范围内的零值正常展示。 */
export function bannerMetricCount(value: number | undefined, report?: BannerStatistics): string {
  if (value === undefined || !report || (!value && !report.coverage.complete)) return '—';
  return new Intl.NumberFormat('zh-CN').format(value);
}
