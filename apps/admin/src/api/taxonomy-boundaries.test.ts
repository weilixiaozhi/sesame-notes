import { describe, expect, it } from 'vitest';
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

describe('健身分类响应边界', () => {
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
});
