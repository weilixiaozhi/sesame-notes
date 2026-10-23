/** 严格解析 CSV / TSV，保留单元格中的换行、空格和空字段；入口可提供错误标签。 */
export function parseDelimited(text: string, delimiter: ',' | '\t', formatLabel = '文件'): string[][] {
  try {
    const input = text.replace(/^\uFEFF/, '');
    const records: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;
    let closed = false;
    /** 完成当前单元格并恢复下一列的引号状态。 */
    const finishCell = () => {
      row.push(cell);
      cell = '';
      closed = false;
    };
    /** 保留有内容的记录，文件中的纯空行不生成导入条目。 */
    const finishRow = () => {
      finishCell();
      if (row.some((value) => value !== '')) records.push(row);
      row = [];
    };
    for (let index = 0; index < input.length; index++) {
      const character = input[index]!;
      if (quoted) {
        // 引号内的双引号表示一个字面引号，分隔符和换行都属于当前单元格。
        if (character === '"' && input[index + 1] === '"') {
          cell += '"';
          index++;
        } else if (character === '"') {
          quoted = false;
          closed = true;
        } else cell += character;
      } else if (character === delimiter) finishCell();
      else if (character === '\n' || character === '\r') {
        finishRow();
        if (character === '\r' && input[index + 1] === '\n') index++;
      } else if (character === '"' && !cell && !closed) quoted = true;
      else {
        // 已闭合引号后只能出现分隔符或换行，普通文本中也不能夹带裸引号。
        if (closed || character === '"') throw new Error(`${formatLabel}引号格式无效`);
        cell += character;
      }
    }
    if (quoted) throw new Error(`${formatLabel}存在未闭合的引号`);
    if (cell || row.length || closed) finishRow();
    return records;
  } catch (error) {
    console.error('解析分隔文本失败', { delimiter, formatLabel, error });
    throw error;
  }
}

/** 读取有表头的 CSV 数据表，拒绝超容量、重复表头和列数不一致的文件。 */
export function parseCsvTable(text: string): { headers: string[]; rows: string[][] } {
  try {
    if (new TextEncoder().encode(text).byteLength > 64 * 1024 * 1024) throw new Error('文件超过 64 MB');
    const records = parseDelimited(text, ',', 'CSV ');
    const headers = records.shift()?.map((value) => value.trim()) ?? [];
    if (!headers.length || headers.some((value) => !value) || new Set(headers).size !== headers.length)
      throw new Error('CSV 表头不能为空或重复');
    if (records.some((record) => record.length !== headers.length)) throw new Error('CSV 各行的列数需要与表头一致');
    return { headers, rows: records };
  } catch (error) {
    console.error('CSV 数据表解析失败', { error });
    throw error;
  }
}
