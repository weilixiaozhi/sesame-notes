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
  /** 历史版本标签的响应覆盖；未列出的标签回落到最新版载荷。 */
  tags: Record<string, () => Response> = {},
  manifest: () => Response = () => Response.json(UPDATE_MANIFEST),
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/releases/latest')) return latest();
    const tag = /\/releases\/tags\/(.+)$/.exec(url)?.[1];
    if (tag) return (tags[tag] ?? (() => Response.json(RELEASE_PAYLOAD)))();
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
    {},
    { ...UPDATE_MANIFEST, version: 'invalid' },
    { ...UPDATE_MANIFEST, version: '1.0.1' },
    { ...UPDATE_MANIFEST, buildNumber: 0 },
    { ...UPDATE_MANIFEST, buildNumber: 1.5 },
    { ...UPDATE_MANIFEST, size: 0 },
    { ...UPDATE_MANIFEST, size: 5 },
    { ...UPDATE_MANIFEST, packageName: 'other.application' },
    { ...UPDATE_MANIFEST, abi: 'other-abi' },
    { ...UPDATE_MANIFEST, sha256: 'invalid' },
    { ...UPDATE_MANIFEST, notes: null },
  ])('拒绝损坏清单并允许上游恢复后重新读取：%j', async (invalid) => {
    try {
      let payload: unknown = invalid;
      const github = stubGithub(undefined, {}, () => Response.json(payload));
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
    [
      [],
      [RELEASE_PAYLOAD.assets[0]],
      [RELEASE_PAYLOAD.assets[1]],
      [RELEASE_PAYLOAD.assets[0], { ...RELEASE_PAYLOAD.assets[1], name: 'Sesame-Notes-prod-v0.9.0.apk' }],
      [{ name: 'notes.txt', url: 'https://api.github.com/repos/o/r/releases/assets/3', size: 0 }],
    ].map((assets) => ({ assets })),
  )('合法发布缺少当前更新附件时返回尚未发布：%j', async ({ assets }) => {
    stubGithub(() => Response.json({ ...RELEASE_PAYLOAD, assets }));
    const response = await createTestApp().inject({ url: '/api/v1/app/update.json' });
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json().code).toBe('APP_RELEASE_NOT_PUBLISHED');
  });

  it.each(
    [
      [{ ...RELEASE_PAYLOAD.assets[0], size: 0 }, RELEASE_PAYLOAD.assets[1]],
      [RELEASE_PAYLOAD.assets[0], { ...RELEASE_PAYLOAD.assets[1], size: -1 }],
      [RELEASE_PAYLOAD.assets[0], { ...RELEASE_PAYLOAD.assets[1], url: 'https://invalid.example/file' }],
    ].map((assets) => ({ assets })),
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

  it('无关零字节附件及待改写的清单地址不影响有效发布', async () => {
    stubGithub(
      () =>
        Response.json({
          ...RELEASE_PAYLOAD,
          assets: [...RELEASE_PAYLOAD.assets, { name: 'notes.txt', url: 'https://api.github.com/notes', size: 0 }],
        }),
      {},
      () => Response.json({ ...UPDATE_MANIFEST, url: null }),
    );
    const response = await createTestApp().inject({ url: '/api/v1/app/update.json' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().url).toBe('https://localhost:80/api/v1/app/download/Sesame-Notes-prod-v1.0.0.apk');
  });

  it('清单解析异常只由全局边界记录一次并保留原始原因', async () => {
    stubGithub(undefined, {}, () => new Response('{invalid'));
    const app = createTestApp();
    const log = vi.spyOn(app.log, 'error');
    try {
      const response = await app.inject({ url: '/api/v1/app/update.json' });
      expect(response.statusCode, response.body).toBe(503);
      expect(response.json().code).toBe('APP_RELEASE_INVALID');
      expect(log).toHaveBeenCalledOnce();
      expect(log.mock.calls[0]![0]).toMatchObject({ err: { cause: { cause: expect.any(SyntaxError) } } });
      expect(response.body).not.toContain('invalid');
    } catch (cause) {
      throw new Error('发布清单异常日志验收失败', { cause });
    } finally {
      log.mockRestore();
    }
  });

  it.each(['/api/v1/app/update.json', '/api/v1/app/download/Sesame-Notes-prod-v1.0.0.apk'])(
    '上游网络故障只记录一次并保留原因：%s',
    async (url) => {
      const cause = new Error('upstream network unavailable');
      const github = stubGithub();
      github.mockRejectedValue(cause);
      const app = createTestApp();
      const log = vi.spyOn(app.log, 'error');
      try {
        const response = await app.inject({ url });
        expect(response.statusCode, response.body).toBe(503);
        expect(response.json().code).toBe('APP_RELEASE_UPSTREAM_FAILED');
        expect(log).toHaveBeenCalledOnce();
        expect(log.mock.calls[0]![0]).toMatchObject({ err: { cause: { cause } } });
        expect(response.body).not.toContain(cause.message);
      } catch (error) {
        throw new Error('发布上游故障日志验收失败', { cause: error });
      } finally {
        log.mockRestore();
      }
    },
  );

  it('serves prod-named assets through the existing update URL', async () => {
    stubGithub(() =>
      Response.json({
        ...RELEASE_PAYLOAD,
        assets: [
          { ...RELEASE_PAYLOAD.assets[0], name: 'update.prod.json' },
          { ...RELEASE_PAYLOAD.assets[1], name: 'Sesame-Notes-prod-v1.0.0.apk' },
        ],
      }),
    );
    const response = await createTestApp().inject({ method: 'GET', url: '/api/v1/app/update.json' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...UPDATE_MANIFEST,
      url: 'https://localhost:80/api/v1/app/download/Sesame-Notes-prod-v1.0.0.apk',
    });
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
  });

  it('不下发 GitHub Token，也不暴露附件直链', async () => {
    stubGithub();
    const app = createTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/app/update.json' });

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

  it('重复检查复用同一份 Release 元数据', async () => {
    const fetchMock = stubGithub();
    const app = createTestApp();
    await app.inject({ method: 'GET', url: '/api/v1/app/update.json' });
    await app.inject({ method: 'GET', url: '/api/v1/app/update.json' });

    const releaseCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/releases/latest'));
    expect(releaseCalls).toHaveLength(1);
  });

  it('未配置更新仓库时明确返回 503 且不访问上游', async () => {
    const github = stubGithub();
    const app = createTestApp({ ...createConfig(), githubReleaseRepository: '' });
    const response = await app.inject({ method: 'GET', url: '/api/v1/app/update.json' });

    expect(response.statusCode).toBe(503);
    expect(github).not.toHaveBeenCalled();
    expect(response.json().code).toBe('APP_RELEASE_NOT_CONFIGURED');
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

  it('GitHub 异常时返回 503 而不是空元数据', async () => {
    stubGithub(() => new Response('upstream down', { status: 500 }));
    const app = createTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/app/update.json' });

    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('APP_RELEASE_UPSTREAM_FAILED');
  });
});

describe('GET /api/v1/app/download/:file', () => {
  it('未配置更新仓库时下载入口也不访问上游', async () => {
    try {
      const github = stubGithub();
      const app = createTestApp({ ...createConfig(), githubReleaseRepository: undefined });
      const response = await app.inject({ method: 'GET', url: '/api/v1/app/download/Sesame-Notes-prod-v1.0.0.apk' });
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe('APP_RELEASE_NOT_CONFIGURED');
      expect(github).not.toHaveBeenCalled();
    } catch (error) {
      throw new Error('未配置更新源的下载隔离验证失败', { cause: error });
    }
  });

  it('downloads the prod-named asset from its matching release tag', async () => {
    const github = stubGithub(undefined, {
      'v1.0.0': () =>
        Response.json({
          ...RELEASE_PAYLOAD,
          assets: [{ ...RELEASE_PAYLOAD.assets[1], name: 'Sesame-Notes-prod-v1.0.0.apk' }],
        }),
    });
    const response = await createTestApp().inject({
      method: 'GET',
      url: '/api/v1/app/download/Sesame-Notes-prod-v1.0.0.apk',
    });
    expect(response.statusCode).toBe(200);
    expect(new Uint8Array(response.rawPayload)).toEqual(APK_BYTES);
    expect(github.mock.calls.some(([url]) => String(url).endsWith('/releases/tags/v1.0.0'))).toBe(true);
  });

  it.each(['Sesame-Notes-test-v1.0.0.apk', 'Sesame-Notes-envTest-v1.0.0.apk'])(
    'rejects a test artifact before contacting GitHub: %s',
    async (file) => {
      const github = stubGithub();
      const response = await createTestApp().inject({ method: 'GET', url: `/api/v1/app/download/${file}` });
      expect(response.statusCode).toBe(404);
      expect(github).not.toHaveBeenCalled();
    },
  );

  it('同 IP 两路占用时第三路被拒绝，完成后释放名额且共享上游查询', async () => {
    try {
      let resolve!: (response: Response) => void;
      const gate = new Promise<Response>((done) => {
        resolve = done;
      });
      const github = stubGithub();
      const original = github.getMockImplementation() as (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => Promise<Response>;
      github.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).includes('/releases/tags/') ? gate : original(input, init),
      );
      const app = createTestApp();
      const url = '/api/v1/app/download/Sesame-Notes-prod-v1.0.0.apk';
      const first = app.inject({ method: 'GET', url }).then((response) => response);
      const second = app.inject({ method: 'GET', url }).then((response) => response);
      await vi.waitFor(() => expect(github).toHaveBeenCalledTimes(1));
      const busy = await app.inject({ method: 'GET', url });
      expect(busy.statusCode).toBe(429);
      expect(busy.headers['retry-after']).toBe('60');
      resolve(Response.json(RELEASE_PAYLOAD));
      expect((await Promise.all([first, second])).map((response) => response.statusCode)).toEqual([200, 200]);
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    } catch (error) {
      throw new Error('下载名额生命周期验证失败', { cause: error });
    }
  });

  it('无效范围释放名额，后续正常下载仍可完成', async () => {
    stubGithub();
    const app = createTestApp();
    const url = '/api/v1/app/download/Sesame-Notes-prod-v1.0.0.apk';
    for (let i = 0; i < 4; i++) {
      const invalid = await app.inject({ method: 'GET', url, headers: { range: 'bytes=0-1,2-3' } });
      expect(invalid.statusCode).toBe(416);
    }
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
  });

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

  it.each([undefined, 'bytes 0-3/4', 'bytes */-1', 'internal-private-diagnostic'])(
    '上游 416 的非完整长度 Content-Range 不透传：%s',
    async (contentRange) => {
      try {
        const github = stubGithub();
        const original = github.getMockImplementation() as (
          input: RequestInfo | URL,
          init?: RequestInit,
        ) => Promise<Response>;
        github.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
          String(input).endsWith('/assets/2')
            ? new Response('上游诊断正文', {
                status: 416,
                headers: contentRange === undefined ? {} : { 'content-range': contentRange },
              })
            : original(input, init),
        );
        const app = createTestApp();
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/app/download/Sesame-Notes-prod-v1.0.0.apk',
          headers: { range: 'bytes=4-' },
        });
        expect(response.statusCode).toBe(416);
        expect(response.headers['content-range']).toBeUndefined();
        expect(response.json().code).toBe('APP_DOWNLOAD_RANGE_INVALID');
        expect(response.body).not.toContain('上游诊断正文');
      } catch (error) {
        throw new Error('上游范围错误头过滤验证失败', { cause: error });
      }
    },
  );

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

  it('按 Release 元数据长度转发安装包字节', async () => {
    stubGithub();
    const app = createTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/app/download/Sesame-Notes-prod-v1.0.0.apk' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/vnd.android.package-archive');
    expect(response.headers['content-length']).toBe('4');
    expect(new Uint8Array(response.rawPayload)).toEqual(APK_BYTES);
  });

  it('历史版本按文件名标签取对应 Release，不会随最新版发布失效', async () => {
    const historical = {
      tag_name: 'v0.9.0',
      assets: [
        { name: 'Sesame-Notes-prod-v0.9.0.apk', url: 'https://api.github.com/repos/o/r/releases/assets/2', size: 4 },
      ],
    };
    const fetchMock = stubGithub(() => Response.json({ ...RELEASE_PAYLOAD, tag_name: 'v1.0.2' }), {
      'v0.9.0': () => Response.json(historical),
    });
    const app = createTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/app/download/Sesame-Notes-prod-v0.9.0.apk' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-length']).toBe('4');
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.endsWith('/releases/tags/v0.9.0'))).toBe(true);
    expect(urls.some((url) => url.endsWith('/releases/latest'))).toBe(false);
  });

  it('标签不存在时返回 404，而不是把上游 404 说成故障', async () => {
    stubGithub(undefined, { 'v0.0.1': () => new Response('missing', { status: 404 }) });
    const app = createTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/app/download/Sesame-Notes-prod-v0.0.1.apk' });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('APP_RELEASE_NOT_FOUND');
  });

  it.each(['Sesame-Notes-v1.0.0.apk', 'Sesame-Notes-test-v1.0.0.apk', 'Sesame-Notes-prod-v1.0.0.zip'])(
    '拒绝转发非正式安装包名：%s',
    async (file) => {
      const github = stubGithub();
      const app = createTestApp();
      const response = await app.inject({ method: 'GET', url: `/api/v1/app/download/${file}` });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('APP_RELEASE_NOT_FOUND');
      expect(github).not.toHaveBeenCalled();
    },
  );

  it('HEAD 只用 Release 元数据应答，不为正文打开上游连接', async () => {
    const fetchMock = stubGithub();
    const app = createTestApp();
    const response = await app.inject({ method: 'HEAD', url: '/api/v1/app/download/Sesame-Notes-prod-v1.0.0.apk' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-length']).toBe('4');
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/assets/2'))).toBe(false);
  });

  it('透传 Range 并原样回传上游的 206 与 content-range', async () => {
    const fetchMock = stubGithub();
    const app = createTestApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/app/download/Sesame-Notes-prod-v1.0.0.apk',
      headers: { range: 'bytes=0-3' },
    });

    expect(response.statusCode).toBe(206);
    expect(response.headers['content-range']).toBe('bytes 0-3/4');
    expect(response.headers['content-length']).toBe('4');
    const apkCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/assets/2'));
    expect((apkCall?.[1]?.headers as Record<string, string> | undefined)?.range).toBe('bytes=0-3');
  });

  it('最新版本缺少附件时返回 404', async () => {
    stubGithub(() =>
      Response.json({ tag_name: 'v1.0.1', assets: [{ name: 'notes.txt', url: 'https://api.github.com/x', size: 1 }] }),
    );
    const app = createTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/app/download/Sesame-Notes-prod-v1.0.1.apk' });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('APP_RELEASE_NOT_FOUND');
  });
});
