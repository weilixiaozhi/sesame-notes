import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isOfficialCatalog, loadOfficialCatalog } from './official-catalog';
import builtin from './exercise-catalog.json';

const cacheKey = 'sesame:official-fitness-catalog:v1';

/** 已停用动作仍携带完整元数据，供历史训练展示正确名称和说明。 */
function publishedCatalog() {
  return {
    schema_version: 1,
    content_version: 2,
    taxonomies: { body_parts: [], equipment: [] },
    exercises: [{ ...builtin.exercises[0], media_url: '/api/v1/fitness/media/builtin-0025', is_enabled: false }],
  };
}

beforeEach(() => {
  localStorage.removeItem(cacheKey);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.removeItem(cacheKey);
});

describe('在线官方动作库', () => {
  it('缓存保留动态分类名称与删除状态，断网后仍能展示同一版标签', async () => {
    const catalog = {
      ...publishedCatalog(),
      taxonomies: {
        body_parts: [{ id: 'chest', name: { zh: '胸部训练', zh_hant: '胸部訓練', en: 'Chest' }, is_deleted: false }],
        equipment: [{ id: 'old', name: { zh: '旧器械', zh_hant: '舊器械', en: 'Old' }, is_deleted: true }],
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(catalog), { status: 200 })));
    expect((await loadOfficialCatalog()).taxonomies).toEqual(catalog.taxonomies);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    expect((await loadOfficialCatalog()).taxonomies).toEqual(catalog.taxonomies);
    expect(isOfficialCatalog({ ...catalog, taxonomies: { body_parts: [] } })).toBe(false);
  });
  it('请求重新验证 HTTP 缓存，保存最新发布并在离线时保留停用动作历史资料', async () => {
    const catalog = publishedCatalog();
    const fetchCatalog = vi.fn().mockResolvedValue(new Response(JSON.stringify(catalog), { status: 200 }));
    vi.stubGlobal('fetch', fetchCatalog);
    expect(await loadOfficialCatalog()).toEqual(catalog);
    expect(fetchCatalog).toHaveBeenCalledWith('/api/v1/fitness/catalog', { signal: undefined, cache: 'no-cache' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('网络不可用')));
    expect(await loadOfficialCatalog()).toEqual(catalog);
  });

  it('有效空发布覆盖旧动作缓存，后续离线也不恢复内置动作', async () => {
    localStorage.setItem(cacheKey, JSON.stringify(publishedCatalog()));
    const empty = {
      schema_version: 1,
      content_version: 3,
      taxonomies: { body_parts: [], equipment: [] },
      exercises: [],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(empty), { status: 200 })));
    expect(await loadOfficialCatalog()).toEqual(empty);
    expect(JSON.parse(localStorage.getItem(cacheKey)!)).toEqual(empty);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('网络不可用')));
    expect(await loadOfficialCatalog()).toEqual(empty);
  });

  it('拒绝外站媒体、重复身份与不完整资料，接受有效空动作库', () => {
    const catalog = publishedCatalog();
    expect(isOfficialCatalog(catalog)).toBe(true);
    expect(isOfficialCatalog({ ...catalog, exercises: [] })).toBe(true);
    expect(isOfficialCatalog({ ...catalog, exercises: [...catalog.exercises, ...catalog.exercises] })).toBe(false);
    expect(
      isOfficialCatalog({
        ...catalog,
        exercises: [{ ...catalog.exercises[0], media_url: 'https://unknown.test/image.gif' }],
      }),
    ).toBe(false);
    expect(isOfficialCatalog({ exercises: [{ id: 'new' }] })).toBe(false);
    expect(
      isOfficialCatalog({ ...catalog, exercises: [{ ...catalog.exercises[0], instructions_en: 'invalid' }] }),
    ).toBe(false);
  });

  it('在线响应缺少分类目录时不能作为有效发布写入缓存', async () => {
    try {
      const { taxonomies: _taxonomies, ...catalog } = publishedCatalog();
      expect(isOfficialCatalog(catalog)).toBe(false);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(catalog), { status: 200 })));
      expect(await loadOfficialCatalog()).toEqual(builtin);
      expect(localStorage.getItem(cacheKey)).toBeNull();
    } catch (cause) {
      throw new Error('在线分类目录完整性验证失败', { cause });
    }
  });

  it('缓存缺少分类目录时使用合法内置文字资源，不要求其拥有公开媒体字段', async () => {
    try {
      const { taxonomies: _taxonomies, ...catalog } = publishedCatalog();
      localStorage.setItem(cacheKey, JSON.stringify(catalog));
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('网络不可用')));
      expect(await loadOfficialCatalog()).toEqual(builtin);
      localStorage.removeItem(cacheKey);
      expect(await loadOfficialCatalog()).toEqual(builtin);
    } catch (cause) {
      throw new Error('离线缓存完整性与内置资源格式验证失败', { cause });
    }
  });

  it('请求取消不回填缓存，也不降级成成功的旧动作库', async () => {
    const controller = new AbortController();
    const catalog = publishedCatalog();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        controller.abort();
        return new Response(JSON.stringify(catalog), { status: 200 });
      }),
    );
    await expect(loadOfficialCatalog(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(localStorage.getItem(cacheKey)).toBeNull();
  });

  it('在线与缓存动作只使用业务字段，不保存素材来源及额外字段', async () => {
    const catalog = publishedCatalog();
    const legacy = {
      ...catalog,
      attribution: 'Legacy library credit',
      exercises: catalog.exercises.map((entry) => ({
        ...entry,
        attribution: 'Legacy image credit — https://legacy.test/',
        server_extra: 'Legacy extra metadata',
      })),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(legacy), { status: 200 })));
    const online = await loadOfficialCatalog();
    expect(online).not.toHaveProperty('attribution');
    expect(online.exercises[0]).not.toHaveProperty('attribution');
    expect(online.exercises[0]).not.toHaveProperty('server_extra');
    expect(localStorage.getItem(cacheKey)).not.toContain('Legacy');

    localStorage.setItem(cacheKey, JSON.stringify(legacy));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('网络不可用')));
    expect(await loadOfficialCatalog()).toEqual(online);
    expect(localStorage.getItem(cacheKey)).not.toContain('Legacy');
  });

  it('无网络且缓存损坏时使用内置文字资料', async () => {
    localStorage.setItem(cacheKey, 'invalid');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('网络不可用')));
    expect(await loadOfficialCatalog()).toEqual(builtin);
  });
});
