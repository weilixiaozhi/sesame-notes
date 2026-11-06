import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';

const apps: Array<ReturnType<typeof buildApp>> = [];

/** 发布通道用例的配置：数据库仅占位，本组用例不访问数据库。 */
function createConfig(githubReleaseToken = 'test-release-token'): ApiConfig {
  return {
    databaseUrl: 'postgresql://sesame:sesame@127.0.0.1:1/sesame_notes',
    jwtSecret: 'test-secret-that-is-at-least-32-bytes-long',
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 2_592_000,
    storagePath: '.test-storage',
    exchangeRateUpstream: 'https://api.frankfurter.dev',
    exchangeRateCacheTtlSeconds: 43_200,
    githubReleaseToken,
    githubReleaseRepository: 'o/r',
    port: 8080,
    host: '127.0.0.1',
    corsOrigins: [],
    rateLimitMax: 1000,
    authRateLimitMax: 1000,
    syncRetentionMinCursor: 0,
    trustProxyCidrs: [],
  };
}

const RELEASE_PAYLOAD = {
  tag_name: 'v1.0.0',
  assets: [
    { name: 'update.prod.json', url: 'https://api.github.com/repos/o/r/releases/assets/1', size: 320 },
    { name: 'Sesame-Notes-prod-v1.0.0.apk', url: 'https://api.github.com/repos/o/r/releases/assets/2', size: 4 },
  ],
};

const UPDATE_MANIFEST = {
  version: '1.0.0',
  buildNumber: 1,
  packageName: 'com.sesame.notes',
  abi: 'arm64-v8a',
  url: 'https://github.com/o/r/releases/download/v1.0.0/Sesame-Notes-prod-v1.0.0.apk',
  size: 4,
  sha256: 'a'.repeat(64),
  notes: '修复若干问题',
};

const APK_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

/** 创建测试服务并在用例结束后统一关闭，避免监听器泄漏影响后续测试。 */
function createTestApp(config: ApiConfig = createConfig()): ReturnType<typeof buildApp> {
  const app = buildApp({ logger: false, config });
  apps.push(app);
  return app;
}

/** 按 URL 模拟 GitHub 两跳响应：Release 元数据与附件字节；返回调用记录用于断言缓存与鉴权。 */
function stubGithub(
  latest: () => Response = () => Response.json(RELEASE_PAYLOAD),
  manifest: () => Response = () => Response.json(UPDATE_MANIFEST),
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/releases/latest')) return latest();
    if (/\/releases\/tags\/.+$/.test(url)) return latest();
    if (url.endsWith('/assets/1')) return manifest();
    if (url.endsWith('/assets/2')) {
      // 上游按 Range 返回 206，用于验证断点续传由上游直接给出范围与长度
      const range = (init?.headers as Record<string, string> | undefined)?.range;
      if (range)
        return new Response(APK_BYTES, {
          status: 206,
          headers: {
            'content-range': `bytes ${range.replace('bytes=', '')}/${APK_BYTES.length}`,
            'content-length': String(APK_BYTES.length),
          },
        });
      return new Response(APK_BYTES, { headers: { 'content-type': 'application/octet-stream' } });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe('GET /api/v1/app/update.json', () => {
  it.each([
    { ...UPDATE_MANIFEST, size: 5 },
    { ...UPDATE_MANIFEST, packageName: 'other.application' },
    { ...UPDATE_MANIFEST, sha256: 'invalid' },
  ])('拒绝损坏清单并允许上游恢复后重新读取：%j', async (invalid) => {
    try {
      let payload: unknown = invalid;
      const github = stubGithub(undefined, () => Response.json(payload));
      const app = createTestApp();
      const failed = await app.inject({ url: '/api/v1/app/update.json' });
      expect(failed.statusCode, failed.body).toBe(503);
      expect(failed.json().code).toBe('APP_RELEASE_INVALID');
      payload = UPDATE_MANIFEST;
      const recovered = await app.inject({ url: '/api/v1/app/update.json' });
      expect(recovered.statusCode, recovered.body).toBe(200);
      expect(recovered.json()).toMatchObject({ version: '1.0.0', size: APK_BYTES.length });
      expect(github.mock.calls.filter(([input]) => String(input).endsWith('/assets/1'))).toHaveLength(2);
    } catch (cause) {
      throw new Error('发布清单校验与失败缓存恢复验收失败', { cause });
    }
  });

  it('按发布标签选择确切 APK，不把前面的历史附件配给当前清单', async () => {
    stubGithub(() =>
      Response.json({
        ...RELEASE_PAYLOAD,
        assets: [{ ...RELEASE_PAYLOAD.assets[1], name: 'Sesame-Notes-prod-v0.9.0.apk' }, ...RELEASE_PAYLOAD.assets],
      }),
    );
    const response = await createTestApp().inject({ url: '/api/v1/app/update.json' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().url).toBe('https://localhost:80/api/v1/app/download/Sesame-Notes-prod-v1.0.0.apk');
  });

  it.each(
    [[RELEASE_PAYLOAD.assets[0], { ...RELEASE_PAYLOAD.assets[1], url: 'https://invalid.example/file' }]].map(
      (assets) => ({ assets }),
    ),
  )('损坏相关附件不能过滤为未发布，修复后可立即重读：%j', async ({ assets }) => {
    try {
      let payload = { ...RELEASE_PAYLOAD, assets };
      const github = stubGithub(() => Response.json(payload));
      const app = createTestApp();
      const failed = await app.inject({ url: '/api/v1/app/update.json' });
      expect(failed.statusCode, failed.body).toBe(503);
      expect(failed.json().code).toBe('APP_RELEASE_INVALID');
      payload = RELEASE_PAYLOAD;
      const recovered = await app.inject({ url: '/api/v1/app/update.json' });
      expect(recovered.statusCode, recovered.body).toBe(200);
      expect(github.mock.calls.filter(([input]) => String(input).endsWith('/releases/latest'))).toHaveLength(2);
    } catch (cause) {
      throw new Error('发布附件损坏与上游恢复验收失败', { cause });
    }
  });

  it('把下载地址改写成服务端入口并保留校验字段', async () => {
    stubGithub();
    const app = createTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/app/update.json' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...UPDATE_MANIFEST,
      url: 'https://localhost:80/api/v1/app/download/Sesame-Notes-prod-v1.0.0.apk',
    });
    expect(response.body).not.toContain('test-release-token');
    expect(response.body).not.toContain('api.github.com');
  });

  it('内部 HTTP 请求经过可信 Nginx 转发后使用公网 HTTPS 下载地址', async () => {
    try {
      stubGithub();
      const app = createTestApp({ ...createConfig(), trustProxyCidrs: ['127.0.0.1'] });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/app/update.json',
        remoteAddress: '127.0.0.1',
        headers: {
          host: '127.0.0.1:8080',
          'x-forwarded-host': 'updates.example.com',
          'x-forwarded-proto': 'https',
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().url).toBe('https://updates.example.com/api/v1/app/download/Sesame-Notes-prod-v1.0.0.apk');
    } catch (error) {
      throw new Error('Nginx HTTPS 入口与内部 HTTP 转发验证失败', { cause: error });
    }
  });

  it.each(['', 'test-release-token'])('使用配置的仓库并按需附带凭据：%s', async (token) => {
    try {
      const github = stubGithub();
      const config = { ...createConfig(token), githubReleaseRepository: 'example-owner/mobile-release' };
      const response = await createTestApp(config).inject({ method: 'GET', url: '/api/v1/app/update.json' });
      expect(response.statusCode).toBe(200);
      expect(github.mock.calls[0]?.[0]).toBe(
        'https://api.github.com/repos/example-owner/mobile-release/releases/latest',
      );
      for (const [, init] of github.mock.calls) {
        const headers = init?.headers as Record<string, string>;
        expect(headers.authorization).toBe(token ? `Bearer ${token}` : undefined);
      }
      expect(response.body).not.toContain('example-owner');
    } catch (error) {
      throw new Error('更新源配置与凭据隔离验证失败', { cause: error });
    }
  });
});

describe('GET /api/v1/app/download/:file', () => {
  it.each(['Sesame-Notes-test-v1.0.0.apk', 'Sesame-Notes-prod-v1.0.0.zip'])(
    '拒绝转发非正式安装包名：%s',
    async (file) => {
      try {
        const github = stubGithub();
        const response = await createTestApp().inject({ method: 'GET', url: `/api/v1/app/download/${file}` });
        expect(response.statusCode).toBe(404);
        expect(github).not.toHaveBeenCalled();
      } catch (cause) {
        throw new Error('安装包转发来源边界验证失败', { cause });
      }
    },
  );

  it('上游范围越界保留 416 和总长度，关闭错误正文并释放下载名额', async () => {
    try {
      const github = stubGithub();
      const original = github.getMockImplementation() as (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => Promise<Response>;
      const cancelled = vi.fn();
      const upstreamSecret = '上游私有签名地址 https://private.example/download?secret=hidden';
      github.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).endsWith('/assets/2')) return original(input, init);
        expect((init?.headers as Record<string, string>).range).toBe('bytes=4-');
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(upstreamSecret));
            },
            cancel: cancelled,
          }),
          {
            status: 416,
            headers: { 'content-range': 'bytes */4', 'content-type': 'text/html', 'content-length': '9999' },
          },
        );
      });
      const app = createTestApp();
      const url = '/api/v1/app/download/Sesame-Notes-prod-v1.0.0.apk';
      for (let attempt = 0; attempt < 4; attempt++) {
        const response = await app.inject({ method: 'GET', url, headers: { range: 'bytes=4-' } });
        expect(response.statusCode).toBe(416);
        expect(response.headers['content-range']).toBe('bytes */4');
        expect(response.headers['content-type']).toContain('application/json');
        expect(response.headers['content-length']).toBe(String(Buffer.byteLength(response.body)));
        expect(response.json()).toMatchObject({
          code: 'APP_DOWNLOAD_RANGE_INVALID',
          message: '下载范围无效，请重新下载',
        });
        expect(response.body).not.toContain(upstreamSecret);
        expect(cancelled).toHaveBeenCalledTimes(attempt + 1);
      }
      github.mockImplementation(original);
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
      const resumed = await app.inject({ method: 'GET', url, headers: { range: 'bytes=0-3' } });
      expect(resumed.statusCode).toBe(206);
      expect(resumed.headers['content-range']).toBe('bytes 0-3/4');
      expect(new Uint8Array(resumed.rawPayload)).toEqual(APK_BYTES);
    } catch (error) {
      throw new Error('上游 416 响应与下载名额回收验证失败', { cause: error });
    }
  });

  it('上游下载失败释放名额并返回可读的 JSON 错误', async () => {
    const github = stubGithub();
    const original = github.getMockImplementation() as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    github.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/assets/2') ? new Response('不可用', { status: 503 }) : original(input, init),
    );
    const app = createTestApp();
    const url = '/api/v1/app/download/Sesame-Notes-prod-v1.0.0.apk';
    for (let i = 0; i < 4; i++) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(503);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.json().code).toBe('APP_RELEASE_UPSTREAM_FAILED');
    }
    github.mockImplementation(original);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
  });
  it('HEAD 与 GET 使用同一文件标识，正确的续传条件保留 Range', async () => {
    stubGithub();
    const app = createTestApp();
    const url = '/api/v1/app/download/Sesame-Notes-prod-v1.0.0.apk';
    const head = await app.inject({ method: 'HEAD', url });
    const etag = String(head.headers.etag);
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    const resumed = await app.inject({ method: 'GET', url, headers: { range: 'bytes=0-3', 'if-match': etag } });
    expect(resumed.statusCode).toBe(206);
    expect(resumed.headers.etag).toBe(etag);
  });

  it('旧文件标识不能续传拼接，If-Range 不匹配则返回完整文件', async () => {
    stubGithub();
    const app = createTestApp();
    const url = '/api/v1/app/download/Sesame-Notes-prod-v1.0.0.apk';
    const rejected = await app.inject({ method: 'GET', url, headers: { range: 'bytes=0-3', 'if-match': '"old"' } });
    expect(rejected.statusCode).toBe(412);
    const complete = await app.inject({ method: 'GET', url, headers: { range: 'bytes=0-3', 'if-range': '"old"' } });
    expect(complete.statusCode).toBe(200);
    expect(new Uint8Array(complete.rawPayload)).toEqual(APK_BYTES);
  });
});
