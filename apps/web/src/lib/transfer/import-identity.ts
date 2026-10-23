/** 根据来源派生兼容客户端 v4 格式的实体 ID，仅作数据身份，不作安全随机数。 */
export async function createImportId(targetBookId: string, exportId: string, sourceEntryId: string): Promise<string> {
  const namespace = new Uint8Array([
    0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
  ]);
  const name = new TextEncoder().encode(`sesame-notes:web:memo-import:${targetBookId}:${exportId}:${sourceEntryId}`);
  const bytes = new Uint8Array(namespace.length + name.length);
  bytes.set(namespace);
  bytes.set(name, namespace.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
