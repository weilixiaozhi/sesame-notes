/** 用本地年月日生成自然日键；日期范围由各领域输入校验负责。 */
export function localDateKey(value = new Date()): string {
  return `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}
