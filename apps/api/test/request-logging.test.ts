import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { safeRequestUrl, serializeRequest } from '../src/shared/request-logging.js';

it.each(['/api/v1/ws', '/api/v1/%77s', '/api/v1/w%73'])('实时握手日志隐藏全部查询参数：%s', async (path) => {
  const records: string[] = [];
  const app = Fastify({
    logger: { stream: { write: (record) => records.push(record) }, serializers: { req: serializeRequest } },
  });
  try {
    app.get('/api/v1/ws', async () => ({ ok: true }));
    const response = await app.inject({ method: 'GET', url: `${path}?ticket=PRIVATE_TICKET&unused=PRIVATE_VALUE` });
    expect(response.statusCode).toBe(200);
    expect(records.join('\n')).toContain('/api/v1/ws');
    expect(records.join('\n')).not.toContain('PRIVATE_TICKET');
    expect(records.join('\n')).not.toContain('PRIVATE_VALUE');
    expect(safeRequestUrl('/api/v1/ws?ticket=PRIVATE_TICKET')).toBe('/api/v1/ws');
    expect(safeRequestUrl('/api/v1/admin/users?search=PRIVATE_PHONE')).toBe('/api/v1/admin');
    expect(safeRequestUrl('/api/v1/%61dmin/users?search=PRIVATE_PHONE')).toBe('/api/v1/admin');
    expect(safeRequestUrl('/api/v1/admin?search=PRIVATE_PHONE')).toBe('/api/v1/admin');
    expect(safeRequestUrl('/api/v1/%invalid?ticket=PRIVATE_TICKET')).toBe('/api/v1/%invalid');
    expect(safeRequestUrl('/api/v1/health?probe=1')).toBe('/api/v1/health?probe=1');
  } catch (cause) {
    throw new Error('实时握手日志隐私验证失败', { cause });
  } finally {
    await app.close();
  }
});
