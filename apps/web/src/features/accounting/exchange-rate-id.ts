const RATE_NAMESPACE = 'cefe9382-b932-5eb7-827d-18944198fbb9';

/** 与服务端和移动端使用相同 UUIDv5 命名空间，使同账号同币种对只产生一份覆盖。 */
export async function exchangeRateOverrideId(ownerId: string, base: string, quote: string): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ownerId))
    throw new Error('账号标识无效，请重新登录。');
  if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote)) throw new Error('请输入三位大写币种代码。');
  const namespace = Uint8Array.from(RATE_NAMESPACE.replaceAll('-', '').match(/.{2}/g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
  const name = new TextEncoder().encode(`${ownerId}:${base}:${quote}`);
  const source = new Uint8Array(namespace.length + name.length);
  source.set(namespace);
  source.set(name, namespace.length);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', source)).slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
