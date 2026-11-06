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
});
