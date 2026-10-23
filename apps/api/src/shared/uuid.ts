import { createHash } from 'node:crypto';

/** 按 RFC 4122 生成 UUIDv5。 服务端与移动端使用同一字节级算法，使成员 ID 可由账本和账号稳定重算， 同步过程不需要维护额外的 ID 映射表。 */
export function uuidV5(namespace: string, name: string): string {
  try {
    const hex = namespace.replaceAll('-', '');
    const ns = Buffer.alloc(16);
    if (hex.length >= 32) {
      Buffer.from(hex, 'hex').copy(ns);
    }
    const hash = createHash('sha1')
      .update(Buffer.concat([ns, Buffer.from(name, 'utf8')]))
      .digest();
    hash[6] = (hash[6]! & 0x0f) | 0x50;
    hash[8] = (hash[8]! & 0x3f) | 0x80;
    const value = hash.toString('hex');
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
  } catch (error) {
    throw new Error('uuidV5 派生失败', { cause: error });
  }
}
