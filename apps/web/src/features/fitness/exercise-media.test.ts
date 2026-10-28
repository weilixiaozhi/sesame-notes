import { describe, expect, it, vi } from 'vitest';
import { exerciseMediaUrl } from './exercise-media';

describe('动作素材地址', () => {
  it('只接受当前服务的公开动作素材地址', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(exerciseMediaUrl('/api/v1/fitness/media/builtin-0025')).toBe('/api/v1/fitness/media/builtin-0025');
      for (const source of [
        'https://example.test/api/v1/fitness/media/builtin-0025',
        '/api/v1/admin/fitness/media/builtin-0025',
        '/fitness/videos/demo.gif',
        'javascript:alert(1)',
      ]) {
        expect(exerciseMediaUrl(source)).toBeUndefined();
      }
    } finally {
      log.mockRestore();
    }
  });
});
