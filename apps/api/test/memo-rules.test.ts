import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateMemoDelta, validateMemoFields } from '../src/modules/memos/testing.js';

const vectors = JSON.parse(
  readFileSync(new URL('../../../test/fixtures/memo_delta_vectors.json', import.meta.url), 'utf8'),
) as { valid: Array<{ id: string; body: unknown }>; invalid: Array<{ id: string; body: unknown }> };

describe('备忘录 delta_v1 共享黄金向量', () => {
  it.each(vectors.valid)('保留 $id 的原始输入', ({ body }) => {
    const before = JSON.stringify(body);
    validateMemoDelta(body);
    expect(JSON.stringify(body)).toBe(before);
  });
  it.each(vectors.invalid)('拒绝 $id，错误不含输入', ({ body }) => {
    expect(() => validateMemoDelta(body)).toThrow('备忘录正文格式无效');
  });
});

describe('账号密码 fields_v1 字段规则', () => {
  const body = (fields: unknown) => ({ fields });

  it('接受自定义字段名、重复字段名、空值与空列表', () => {
    expect(() => validateMemoFields(body([]))).not.toThrow();
    expect(() =>
      validateMemoFields(
        body([
          { label: '登录用户名', value: 'first' },
          { label: '登录用户名', value: '' },
          { label: '支付密码', value: '\u0000 🔑' },
        ]),
      ),
    ).not.toThrow();
  });

  it.each([
    ['字段名为空白', body([{ label: '  ', value: 'v' }])],
    ['字段名超长', body([{ label: 'x'.repeat(65), value: 'v' }])],
    ['字段值超长', body([{ label: 'x', value: 'v'.repeat(2049) }])],
    ['字段数量超限', body(Array.from({ length: 21 }, (_, index) => ({ label: `f${index}`, value: '' })))],
    ['字段不是数组', { fields: 'x' }],
    ['未知键', { fields: [], extra: 1 }],
    ['字段缺值', body([{ label: 'x' }])],
    ['字段值非字符串', body([{ label: 'x', value: 1 }])],
  ])('拒绝 %s', (_name, value) => {
    expect(() => validateMemoFields(value)).toThrow('账号密码字段无效');
  });
});
