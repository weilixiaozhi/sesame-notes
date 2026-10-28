import { describe, expect, it, vi } from 'vitest';
import { deltaSchema, fieldsSchema, hasVisibleText, isWellFormed, logMemoError } from './memo-content';

describe('备忘录富文本的跨端格式边界', () => {
  it('保存粗体、标题、清单和缩进，不裁剪文本', () => {
    const body = {
      ops: [
        { insert: '  标题  ', attributes: { bold: true } },
        { insert: '\n', attributes: { header: 2 } },
        { insert: '事项' },
        { insert: '\n', attributes: { list: 'checked', indent: 5 } },
      ],
    };
    expect(deltaSchema.parse(body)).toEqual(body);
  });
  it.each([
    { ops: [{ insert: '没有结尾换行' }] },
    { ops: [{ insert: { image: 'https://example.com/a.png' } }, { insert: '\n' }] },
    { ops: [{ insert: '正文\n', attributes: { list: 'bullet' } }] },
    { ops: [{ insert: '\n', attributes: { header: 1, list: 'ordered' } }] },
    { ops: [{ insert: '\n', attributes: { indent: 6 } }] },
    { ops: [{ insert: '\n', attributes: { italic: true } }] },
    { ops: [{ retain: 1 }, { insert: '\n' }] },
    { ops: [{ insert: '\uD800\n' }] },
  ])('拒绝可能破坏移动端正文的格式 %j', (body) => {
    expect(deltaSchema.safeParse(body).success).toBe(false);
  });
  it('允许表情，拒绝孤立代理码元', () => {
    expect(isWellFormed('🌱')).toBe(true);
    expect(isWellFormed('\uDFFF')).toBe(false);
  });
});

describe('账号卡片字段与隐私边界', () => {
  it('错误日志记录定位信息并排除字段值与异常消息', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const error = new Error('example-password\nother-field-value');
      logMemoError('导出失败', error, { entryId: 'memo' });
      expect(output).toHaveBeenCalledWith('导出失败', expect.objectContaining({ errorType: 'Error', entryId: 'memo' }));
      expect(JSON.stringify(output.mock.calls)).not.toContain('example-password');
      expect(JSON.stringify(output.mock.calls)).not.toContain('other-field-value');
    } finally {
      output.mockRestore();
    }
  });
  it('允许空字段值，但不修剪密码内容', () => {
    const body = {
      fields: [
        { label: '密码', value: '  secret  ' },
        { label: '备注', value: '' },
      ],
    };
    expect(fieldsSchema.parse(body)).toEqual(body);
  });
  it('限制字段数量和长度，拒绝空白名称和未知字段', () => {
    expect(
      fieldsSchema.safeParse({ fields: Array.from({ length: 21 }, () => ({ label: 'a', value: '' })) }).success,
    ).toBe(false);
    expect(fieldsSchema.safeParse({ fields: [{ label: '\u200B', value: '' }] }).success).toBe(false);
    expect(fieldsSchema.safeParse({ fields: [{ label: 'a', value: 'x'.repeat(2049) }] }).success).toBe(false);
    expect(fieldsSchema.safeParse({ fields: [{ label: 'a', value: '', extra: true }] }).success).toBe(false);
    expect(hasVisibleText('  ')).toBe(false);
  });
});
