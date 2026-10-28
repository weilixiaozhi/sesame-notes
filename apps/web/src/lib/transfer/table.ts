import { assertUniqueJsonKeys } from './json';
import { parseDelimited } from '../delimited-text';

export type TransferTable = { name: string; records: string[][] };
export type SelectedTable = { headers: string[]; rows: string[][] };
const MAX_TABLE_COLUMNS = 200;
const MAX_TABLE_ROWS = 100_000;

/** 表头可显式关闭；列数不一致时禁止凭猜测移动金额或日期。 */
export function selectTable(table: TransferTable, hasHeader: boolean): SelectedTable {
  const first = table.records[0];
  if (!first?.length) throw new Error('所选数据表没有内容');
  const headers = hasHeader ? first.map((value) => value.trim()) : first.map((_, i) => `第 ${i + 1} 列`);
  if (headers.some((value) => !value) || new Set(headers).size !== headers.length)
    throw new Error('表头不能为空或重复，可关闭“首行是表头”后手动映射');
  const rows = table.records.slice(hasHeader ? 1 : 0);
  if (rows.some((row) => row.length !== headers.length)) throw new Error('文件各行列数不一致，请先修正源文件');
  if (!rows.length) throw new Error('所选数据表没有明细');
  return { headers, rows };
}

/** 金额数字先保留为十进制文本，避免 JSON.parse 的 IEEE754 舍入损坏精度。 */
function preserveJsonNumbers(text: string): string {
  let output = '';
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      output += char;
    } else if (char === '-' || /\d/.test(char)) {
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?/i.exec(text.slice(index));
      if (!match) throw new Error('JSON 数值格式错误');
      const literal = match[0];
      output += JSON.stringify(literal);
      index += literal.length - 1;
    } else output += char;
  }
  return output;
}
/** JSON 对象数组按路径提供选择，绝不把外层包装字段当作交易。 */
export function parseJsonTables(text: string): TransferTable[] {
  assertUniqueJsonKeys(text);
  const decoded: unknown = JSON.parse(preserveJsonNumbers(text));
  const sources = new Map<string, Record<string, unknown>[]>();
  const visit = (value: unknown, path: string, depth: number) => {
    if (depth > 40) throw new Error('JSON 嵌套过深');
    if (Array.isArray(value)) {
      if (value.length && value.every((item) => !!item && typeof item === 'object' && !Array.isArray(item))) {
        const rows = sources.get(path) ?? [];
        // 同一路径下的嵌套数组逐条追加，避免每次复制已经收集的全部记录。
        for (const row of value) rows.push(row as Record<string, unknown>);
        sources.set(path, rows);
      }
      for (const item of value) visit(item, `${path}[]`, depth + 1);
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        // 标点属于字段名时使用带引号的片段，避免与真正的对象层级或数组标记合并。
        const segment = /^[A-Z_$][\w$]*$/i.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
        visit(item, `${path}${segment}`, depth + 1);
      }
    }
  };
  visit(decoded, '$', 0);
  if (!sources.size) throw new Error('JSON 中没有对象数组，请提供明细数组');
  return [...sources].map(([name, rows]) => {
    const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    // 稀疏对象展开为矩形表格前检查维度，避免小文件因列并集膨胀为平方级单元格。
    if (headers.length > MAX_TABLE_COLUMNS || rows.length > MAX_TABLE_ROWS)
      throw new Error('JSON 数据表超过 200 列或 100000 行，请拆分后导入');
    return {
      name,
      records: [
        headers,
        ...rows.map((row) =>
          headers.map((header) => {
            // 表头取各行字段的并集，当前行缺失的列必须为空，不能读取对象原型上的同名属性。
            const value = Object.hasOwn(row, header) ? row[header] : undefined;
            return value === null || value === undefined
              ? ''
              : typeof value === 'object'
                ? JSON.stringify(value)
                : String(value);
          }),
        ),
      ],
    };
  });
}

/** 文件在浏览器解析；XLSX 只读取值，不执行公式或访问外部链接。 */
export async function readTransferFile(file: File): Promise<TransferTable[]> {
  if (file.size > 64 * 1024 * 1024) throw new Error('文件超过 64 MB');
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  if (extension === 'xlsx') {
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    return workbook.worksheets
      .map((sheet) => {
        const records: string[][] = [];
        const width = sheet.columnCount;
        if (width > MAX_TABLE_COLUMNS || sheet.rowCount > MAX_TABLE_ROWS)
          throw new Error('工作表超过 200 列或 100000 行，请拆分后导入');
        sheet.eachRow((row) => {
          const cells = Array.from({ length: width }, (_, i) => {
            const cell = row.getCell(i + 1);
            const value = cell.value;
            if (value instanceof Date) return value.toISOString();
            if (typeof value === 'number' && Math.abs(value) > Number.MAX_SAFE_INTEGER)
              throw new Error('工作表金额超出安全精度，请使用文本单元格');
            if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value))
              throw new Error('工作表包含公式，请先将公式粘贴为值后导入');
            if (value && typeof value === 'object' && 'error' in value) throw new Error('工作表包含错误单元格');
            return cell.text;
          });
          if (cells.some(Boolean)) records.push(cells);
        });
        return { name: sheet.name, records };
      })
      .filter((sheet) => sheet.records.length);
  }
  const text = (await file.text()).replace(/^\uFEFF/, '');
  if (extension === 'json' || /^\s*[[{]/.test(text)) return parseJsonTables(text);
  if (!['csv', 'tsv', 'txt'].includes(extension ?? '')) throw new Error('请选择 CSV、TSV、TXT、XLSX 或 JSON 文件');
  return [
    {
      name: file.name,
      records: parseDelimited(text, extension === 'tsv' || text.split(/\r?\n/, 1)[0]?.includes('\t') ? '\t' : ','),
    },
  ];
}
