import { createHash } from 'node:crypto';

/** 对 JSON 请求做递归键排序并计算 SHA-256；对象字段顺序不影响语义，数组顺序保持不变。 */
export function requestFingerprint(value: unknown): string {
  try {
    const stableJson = JSON.stringify(value, (_key, current: unknown) => {
      if (current === null || typeof current !== 'object' || Array.isArray(current)) return current;
      return Object.fromEntries(
        Object.entries(current as Record<string, unknown>).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      );
    });
    return createHash('sha256').update(stableJson, 'utf8').digest('hex');
  } catch (error) {
    throw new Error('请求指纹计算失败', { cause: error });
  }
}
