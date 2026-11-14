import { describe, expect, it } from 'vitest';
import { deltaSchema, memoImageIds, memoPreview } from './memo-content';

const imageId = '9f8e7d6c-5b4a-4392-8171-60514f3e2d1c';
const secondImageId = '1a2b3c4d-5e6f-4a70-8b91-c2d3e4f5a6b7';

/** 图片合法 op 前后都有换行，保持图片独占一段。 */
function imageBody(ops: unknown[]): { ops: unknown[] } {
  return { ops };
}

const validImageBody = imageBody([{ insert: '看图\n' }, { insert: { memo_image: imageId } }, { insert: '\n' }]);

describe('备忘录正文图片校验', () => {
  it('接受图片引用且不把图片作为摘要文字', () => {
    expect(deltaSchema.safeParse(validImageBody).success).toBe(true);
    expect(memoPreview({ book_type: 'normal', title: '标题', body: validImageBody })).toBe('看图');
    expect(memoPreview({ book_type: 'normal', title: '标题', body: validImageBody })).not.toContain(imageId);
  });

  it('图片不产生摘要文字，纯图片正文摘要为空', () => {
    const body = imageBody([{ insert: { memo_image: imageId } }, { insert: '\n' }]);
    expect(memoPreview({ book_type: 'normal', title: '', body })).toBe('');
  });

  it('接受带显示比例的图片引用，摘要与导出仍只使用媒体标识', () => {
    const body = imageBody([{ insert: { memo_image: `${imageId}|50` } }, { insert: '\n' }]);
    expect(deltaSchema.safeParse(body).success).toBe(true);
    expect(memoImageIds(body)).toEqual([imageId]);
    expect(memoPreview({ book_type: 'normal', title: '', body })).toBe('');
  });

  it('拒绝非法图片标识与额外键', () => {
    for (const value of [
      'invalid',
      imageId.toUpperCase(),
      `${imageId}x`,
      `${imageId}|0`,
      `${imageId}|5`,
      `${imageId}|101`,
    ]) {
      expect(deltaSchema.safeParse(imageBody([{ insert: { memo_image: value } }, { insert: '\n' }])).success).toBe(
        false,
      );
    }
    expect(
      deltaSchema.safeParse(imageBody([{ insert: { memo_image: imageId, width: 10 } }, { insert: '\n' }])).success,
    ).toBe(false);
  });

  it('拒绝图片 op 携带段落属性或尺寸信息', () => {
    expect(
      deltaSchema.safeParse(
        imageBody([{ insert: { memo_image: imageId }, attributes: { header: 1 } }, { insert: '\n' }]),
      ).success,
    ).toBe(false);
    expect(
      deltaSchema.safeParse(
        imageBody([{ insert: { memo_image: imageId }, attributes: { bold: true } }, { insert: '\n' }]),
      ).success,
    ).toBe(false);
  });

  it('单篇最多允许 20 张图片', () => {
    const images = Array.from({ length: 20 }, () => ({ insert: { memo_image: imageId } }));
    expect(deltaSchema.safeParse(imageBody([{ insert: '开头\n' }, ...images, { insert: '\n' }])).success).toBe(true);
    expect(
      deltaSchema.safeParse(imageBody([{ insert: '开头\n' }, ...images, images[0], { insert: '\n' }])).success,
    ).toBe(false);
  });

  it('图片不能作为末段，最后一条 op 仍须是换行文字', () => {
    expect(deltaSchema.safeParse(imageBody([{ insert: '图片' }, { insert: { memo_image: imageId } }])).success).toBe(
      false,
    );
    expect(
      deltaSchema.safeParse(imageBody([{ insert: '图片' }, { insert: { memo_image: imageId } }, { insert: '\n' }]))
        .success,
    ).toBe(true);
  });

  it('保留文字属性与换行规则', () => {
    expect(deltaSchema.safeParse(imageBody([{ insert: '标题\n', attributes: { header: 1 } }])).success).toBe(false);
    expect(
      deltaSchema.safeParse(imageBody([{ insert: '\n', attributes: { header: 1, list: 'ordered' } }])).success,
    ).toBe(false);
    expect(deltaSchema.safeParse(imageBody([{ insert: '\n', attributes: { color: 'red' } }])).success).toBe(false);
  });

  it('按出现顺序去重提取图片标识，损坏正文返回空列表', () => {
    const body = imageBody([
      { insert: { memo_image: imageId } },
      { insert: '\n' },
      { insert: { memo_image: secondImageId } },
      { insert: { memo_image: imageId } },
      { insert: '\n' },
    ]);
    expect(memoImageIds(body)).toEqual([imageId, secondImageId]);
    expect(memoImageIds({ ops: [{ insert: '缺少换行' }] })).toEqual([]);
    expect(memoImageIds(null)).toEqual([]);
  });
});
