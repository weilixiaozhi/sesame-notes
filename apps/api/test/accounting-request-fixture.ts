import type { FastifyInstance } from 'fastify';

/** 为业务回归夹具取得当前预览参数；显式提供参数的边界用例保持原始请求。 */
export async function accountingRequestFixturePath(
  app: FastifyInstance,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<string> {
  try {
    const url = new URL(path, 'http://accounting-fixture');
    const match = /^(?:\/api\/v1)?\/ledgers\/([0-9a-f-]{36})(\/imports)?$/.exec(url.pathname);
    if (!match) return path;
    const importing = method.toUpperCase() === 'POST' && match[2] === '/imports';
    const deleting = method.toUpperCase() === 'DELETE' && !match[2];
    if ((!importing && !deleting) || url.searchParams.has('expected_sync_id')) return path;
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/ledgers/${match[1]}${deleting ? '/action-preview' : ''}`,
      headers,
    });
    // 无权限的夹具仍发送完整合法参数，让待测写入口自行验证授权。
    const preview = response.statusCode === 200 ? response.json() : {};
    url.searchParams.set('expected_sync_id', preview.sync_id ?? '00000000-0000-4000-8000-000000000001');
    if (deleting) url.searchParams.set('expected_fingerprint', preview.fingerprint ?? '0'.repeat(64));
    else {
      url.searchParams.set('expected_currency', preview.currency ?? 'CNY');
      url.searchParams.set('require_unarchived', 'true');
    }
    return `${url.pathname}${url.search}`;
  } catch (error) {
    console.error('记账回归预览参数准备失败', { method, path, error });
    throw new Error('记账回归请求夹具构造失败', { cause: error });
  }
}
