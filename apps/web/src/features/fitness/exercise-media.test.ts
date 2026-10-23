import { describe, expect, it, vi } from 'vitest';
import { exerciseMediaUrl } from './exercise-media';

describe('动作素材地址', () => {
  it('保留服务端素材身份，只在列表请求首帧，详情移除预览标记', () => {
    const url = '/api/v1/fitness/media/builtin-0025';
    expect(exerciseMediaUrl(url, true)).toBe(`${url}?preview=1`);
    expect(exerciseMediaUrl(`${url}?preview=1`)).toBe(url);
    expect(exerciseMediaUrl(`${window.location.origin}${url}`, true)).toBe(`${url}?preview=1`);
    expect(exerciseMediaUrl(undefined, true)).toBeUndefined();
  });

  it('拒绝站外地址、管理端素材和本地 GIF 路径，避免列表误下载其他资源', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const source of [
        'https://example.test/api/v1/fitness/media/builtin-0025',
        '/api/v1/admin/fitness/media/builtin-0025',
        '/fitness/videos/demo.gif',
        'javascript:alert(1)',
      ]) {
        expect(exerciseMediaUrl(source, true)).toBeUndefined();
      }
      expect(log).toHaveBeenCalledTimes(4);
    } finally {
      log.mockRestore();
    }
  });
});
