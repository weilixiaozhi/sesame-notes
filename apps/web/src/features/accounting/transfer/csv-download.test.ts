import { it, expect } from 'vitest';
import { inspectCsv } from './csv-download';
import { parseDelimited } from '../../../lib/delimited-text';

/** 以实际引号规则构造中文与跨行的原值交换文件。 */
function csv(rows: string[][]): string {
  return `\uFEFF${rows.map((row) => row.map((cell) => (/[",\r\n]/u.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell)).join(',')).join('\r\n')}`;
}

it('危险开头均转为文字，不改金额精度、中文或原有单引号', () => {
  const ordinary = ['普通中文', '123456789012345678.1234567891', "'=原有单引号", '中,文"引号\n第二行'];
  const danger = ['=1+1', '+SUM(1,2)', '-2+3', '@SUM(1+1)', '  =1+1', '\t1+1', '\ntext', '＝1+1'];
  const input = csv([['备注', '金额', '原文', '多行'], ordinary, danger.slice(0, 4), danger.slice(4)]);
  const result = inspectCsv(input);
  expect(result.riskyCells).toBe(8);
  expect(parseDelimited(result.safeText, ',')).toEqual([
    ['备注', '金额', '原文', '多行'],
    ordinary,
    danger.slice(0, 4).map((value) => `'${value}`),
    danger.slice(4).map((value) => `'${value}`),
  ]);
  expect(result.safeText.startsWith('\uFEFF')).toBe(true);
});
