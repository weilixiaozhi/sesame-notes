import type { Catalog } from './fitness-types';
import { isTaxonomyDirectory } from './taxonomy';

const CACHE_KEY = 'sesame:official-fitness-catalog:v1';

/** 校验动作业务字段；公开发布要求媒体与启用状态，内置文字资源允许省略投递字段。 */
function isCatalogContent(value: unknown, published: boolean): value is Catalog {
  if (!value || typeof value !== 'object' || !('exercises' in value) || !Array.isArray(value.exercises)) return false;
  return (
    value.exercises.every((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return false;
      const item = entry as Record<string, unknown>;
      return (
        typeof item.id === 'string' &&
        typeof item.name_zh === 'string' &&
        typeof item.name_zh_hant === 'string' &&
        typeof item.name_en === 'string' &&
        typeof item.body_part === 'string' &&
        typeof item.equipment === 'string' &&
        typeof item.gif_asset === 'string' &&
        typeof item.target === 'string' &&
        ['secondary_muscles', 'instructions_zh'].every(
          (key) => Array.isArray(item[key]) && (item[key] as unknown[]).every((part) => typeof part === 'string'),
        ) &&
        ['instructions_zh_hant', 'instructions_en'].every(
          (key) =>
            item[key] === undefined ||
            (Array.isArray(item[key]) && (item[key] as unknown[]).every((part) => typeof part === 'string')),
        ) &&
        ((item.is_enabled === undefined && !published) || typeof item.is_enabled === 'boolean') &&
        ((item.media_url === undefined && !published) ||
          (typeof item.media_url === 'string' &&
            /^\/api\/v1\/fitness\/media\/(?:[a-f0-9]{64}|builtin-[\w-]{1,128})$/.test(item.media_url)))
      );
    }) && new Set(value.exercises.map((entry: { id: string }) => entry.id)).size === value.exercises.length
  );
}

/** 在线目录必须携带完整分类快照；空目录也是有效发布，媒体仅允许本站受控 API 路径。 */
export function isOfficialCatalog(value: unknown): value is Catalog {
  return isCatalogContent(value, true) && isTaxonomyDirectory(value.taxonomies);
}

/** 按动作目录业务字段构造网页数据，服务端额外字段不进入动作状态或缓存。 */
function cleanCatalog(catalog: Catalog): Catalog {
  const { attribution: _attribution, ...metadata } = catalog as Catalog & { attribution?: unknown };
  return {
    ...metadata,
    exercises: catalog.exercises.map((entry) => ({
      id: entry.id,
      name_zh: entry.name_zh,
      name_zh_hant: entry.name_zh_hant,
      name_en: entry.name_en,
      body_part: entry.body_part,
      equipment: entry.equipment,
      target: entry.target,
      secondary_muscles: entry.secondary_muscles,
      instructions_zh: entry.instructions_zh,
      gif_asset: entry.gif_asset,
      ...(entry.instructions_zh_hant === undefined ? {} : { instructions_zh_hant: entry.instructions_zh_hant }),
      ...(entry.instructions_en === undefined ? {} : { instructions_en: entry.instructions_en }),
      ...(entry.media_url === undefined ? {} : { media_url: entry.media_url }),
      ...(entry.is_enabled === undefined ? {} : { is_enabled: entry.is_enabled }),
    })),
  };
}

/** 保存已清理的公开资料，浏览器拒绝缓存时仍可继续使用本次成功读取的动作库。 */
function rememberCatalog(catalog: Catalog): Catalog {
  const clean = cleanCatalog(catalog);
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(clean));
  } catch (error) {
    console.warn('动作库缓存暂时无法保存', error);
  }
  return clean;
}

/** 在线发布优先并重新验证 HTTP 缓存；离线保留最近一次有效发布或内置文字资料。 */
export async function loadOfficialCatalog(signal?: AbortSignal): Promise<Catalog> {
  try {
    signal?.throwIfAborted();
    const response = await fetch('/api/v1/fitness/catalog', { signal, cache: 'no-cache' });
    if (!response.ok) throw new Error(`动作库请求失败（${response.status}）`);
    const catalog: unknown = await response.json();
    signal?.throwIfAborted();
    if (!isOfficialCatalog(catalog)) throw new Error('官方动作库格式无效');
    return rememberCatalog(catalog);
  } catch (error) {
    if (signal?.aborted) throw error;
    console.warn('在线动作库暂时不可用，读取本地资料', error);
    try {
      const cached: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
      if (isOfficialCatalog(cached)) return rememberCatalog(cached);
    } catch (cacheError) {
      console.warn('动作库缓存无法读取', cacheError);
    }
    try {
      const builtin = (await import('./exercise-catalog.json')).default;
      signal?.throwIfAborted();
      if (!isCatalogContent(builtin, false)) throw new Error('内置动作库格式无效');
      return cleanCatalog(builtin);
    } catch (fallbackError) {
      if (signal?.aborted) throw fallbackError;
      console.error('读取内置动作库资料失败', fallbackError);
      throw new Error('动作库暂时无法打开，请联网后重试。', { cause: fallbackError });
    }
  }
}
