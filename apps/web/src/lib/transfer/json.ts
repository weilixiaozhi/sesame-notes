/** 在 JSON.parse 合并重复键前拒绝歧义文件，转义后相同的键也视为重复。 */
export function assertUniqueJsonKeys(text: string): void {
  const stack: Array<{ object: boolean; key: boolean; names: Set<string> }> = [];
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]/g) ?? [];
  try {
    for (const token of tokens) {
      const current = stack.at(-1);
      if (token === '{' || token === '[') stack.push({ object: token === '{', key: token === '{', names: new Set() });
      else if (token === '}' || token === ']') stack.pop();
      else if (token === ',' && current?.object) current.key = true;
      else if (token === ':' && current?.object) current.key = false;
      else if (token.startsWith('"') && current?.object && current.key) {
        const key = JSON.parse(token) as string;
        if (current.names.has(key)) throw new Error('重复字段');
        current.names.add(key);
      }
    }
  } catch {
    throw new Error('JSON 文件包含重复或无效字段');
  }
}
