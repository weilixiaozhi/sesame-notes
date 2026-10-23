// @vitest-environment jsdom
import { ApiError } from '@sesame-notes/api-client';
import { describe, expect, it } from 'vitest';
import { errorMessage } from './client';
import { validateAdminResponse } from './response-validation';

const row = {
  id: 'category',
  kind: 'body_part',
  name: { zh: '核心', zh_hant: '核心', en: 'Core' },
  sort_order: 0,
  version: 1,
  is_deleted: false,
  exercise_count: 0,
  template_count: 0,
};

describe('健身分类响应与错误提示', () => {
  it('读取目录和保存分类响应必须包含三语名称、版本和引用数', () => {
    for (const [method, path, list] of [
      ['GET', '/api/v1/admin/fitness/taxonomies/{kind}', true],
      ['POST', '/api/v1/admin/fitness/taxonomies/{kind}', false],
      ['PATCH', '/api/v1/admin/fitness/taxonomies/{kind}/{taxon_id}', false],
    ] as const) {
      expect(() =>
        validateAdminResponse({ method, path, status: 200, body: list ? { items: [row] } : row }),
      ).not.toThrow();
      for (const invalid of [
        { ...row, exercise_count: undefined },
        { ...row, version: 0 },
        { ...row, name: { zh: '核心' } },
      ]) {
        expect(() =>
          validateAdminResponse({ method, path, status: 200, body: list ? { items: [invalid] } : invalid }),
        ).toThrow();
      }
    }
  });

  it.each([
    ['FITNESS_TAXON_CHANGED', '核对最新资料'],
    ['FITNESS_TAXON_REFERENCED', '选择替代项'],
    ['FITNESS_TAXON_REPLACEMENT_INVALID', '同类型'],
    ['FITNESS_TAXON_UNAVAILABLE', '重新选择'],
  ])('错误 %s 不暴露内部标识并提示下一步', (code, message) => {
    expect(errorMessage(new ApiError(409, code, 'internal-error'))).toContain(message);
  });
});
