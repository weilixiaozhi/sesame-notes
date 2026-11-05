import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadTestApiConfig } from './test-api-config.js';

const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe('官方训练内容库', () => {
  it('公开读取并使用 ETag 避免重复下载', async () => {
    const app = buildApp({ logger: false, config: loadTestApiConfig() });
    apps.push(app);
    await app.ready();

    const first = await app.inject({ method: 'GET', url: '/api/v1/fitness/library' });
    expect(first.statusCode).toBe(200);
    expect(first.headers.etag).toMatch(/^"fitness-[0-9a-f]{24}"$/);
    expect(first.json()).toMatchObject({ schema_version: 1, content_version: expect.any(Number) });
    expect(first.json().content_version).toBeGreaterThanOrEqual(1);
    // 内容未变化时 ETag 必须稳定，否则条件请求永远无法命中。
    const repeated = await app.inject({ method: 'GET', url: '/api/v1/fitness/library' });
    expect(repeated.headers.etag).toBe(first.headers.etag);

    const cached = await app.inject({
      method: 'GET',
      url: '/api/v1/fitness/library',
      headers: { 'if-none-match': first.headers.etag! },
    });
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBe('');
  });
});
