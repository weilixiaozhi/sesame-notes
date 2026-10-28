import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import type { ApiConfig } from '../../shared/api-config.js';
import { ApiError } from '../../shared/errors.js';
import { createRateLimit } from '../../shared/rate-limit.js';
import { ReleaseCache, ReleaseDownloads } from './release-resources.js';

const GITHUB_API = 'https://api.github.com';
/** CI 生成的更新元数据附件名，字段含义见客户端 scripts/generate_update_manifest.py。 */
const MANIFEST_ASSET_NAME = 'update.prod.json';
/** 正式安装包名包含 prod 和版本标签，公开下载按标签定位对应 Release。 */
const APK_ASSET_NAME = /^Sesame-Notes-prod-(v\d+\.\d+\.\d+)\.apk$/;
const METADATA_TIMEOUT_MS = 15_000;
/** 安装包超过 100 MB，超时仅用于兜住挂死的上游连接，不限制正常下载时长。 */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const APK_CONTENT_TYPE = 'application/vnd.android.package-archive';

type ReleaseAsset = { name: string; url: string; size: number };
type ReleaseMetadata = { tagName: string; assets: ReleaseAsset[] };

/** 注册应用内更新入口：元数据与安装包由服务端从显式配置的 GitHub 仓库取得。 */
export function registerAppReleaseRoutes(app: FastifyInstance, config: ApiConfig): void {
  const cache = new ReleaseCache();
  const downloads = new ReleaseDownloads();
  const releaseRateLimit = createRateLimit(30, 60_000);

  /** 未设置更新仓库时停止查询，避免默认访问其他部署者的发布通道。 */
  function requireReleaseRepository(): string {
    if (!config.githubReleaseRepository) throw new ApiError(503, 'APP_RELEASE_NOT_CONFIGURED', '更新源尚未配置');
    return config.githubReleaseRepository;
  }

  /** GitHub 请求头：Token 只出现在服务端到 GitHub 的这一次请求里，不下发到客户端。 */
  function githubHeaders(accept: string): Record<string, string> {
    return {
      accept,
      ...(config.githubReleaseToken ? { authorization: `Bearer ${config.githubReleaseToken}` } : {}),
      'user-agent': config.deploymentEnvironment === 'test' ? 'sesame-notes-test-api' : 'sesame-notes-prod-api',
    };
  }

  /** 校验发布结构和更新渠道附件；无关附件允许为空，相关附件损坏必须明确暴露。 */
  function parseReleaseMetadata(payload: unknown): ReleaseMetadata {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalidRelease('发布响应结构无效');
    const record = payload as Record<string, unknown>;
    if (typeof record.tag_name !== 'string' || !record.tag_name || !Array.isArray(record.assets))
      throw invalidRelease('发布标签或附件列表无效');
    const assets: ReleaseAsset[] = [];
    for (const asset of record.assets) {
      if (!asset || typeof asset !== 'object' || Array.isArray(asset)) throw invalidRelease('发布附件结构无效');
      const item = asset as Record<string, unknown>;
      if (typeof item.name !== 'string' || !item.name) throw invalidRelease('发布附件名称无效');
      if (item.name !== MANIFEST_ASSET_NAME && !APK_ASSET_NAME.test(item.name)) continue;
      // 相关附件必须通过 GitHub API 下载，正字节数是清单与安装包可用的必要条件。
      if (
        typeof item.url !== 'string' ||
        !item.url.startsWith(`${GITHUB_API}/`) ||
        typeof item.size !== 'number' ||
        !Number.isSafeInteger(item.size) ||
        item.size <= 0
      )
        throw invalidRelease('更新附件的下载地址或长度无效');
      assets.push({ name: item.name, url: item.url, size: item.size });
    }
    return { tagName: record.tag_name, assets };
  }

  /** 上游契约错误保留安全诊断原因，统一由请求错误边界记录并返回友好信息。 */
  function invalidRelease(reason: string): ApiError {
    return new ApiError(503, 'APP_RELEASE_INVALID', '更新源返回了无效数据', undefined, { cause: new Error(reason) });
  }

  /** 清单已有字段与当前发布和安装包建立同一身份，验证通过后才能进入成功缓存。 */
  function parseUpdateManifest(payload: unknown, release: ReleaseMetadata, apk: ReleaseAsset): Record<string, unknown> {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalidRelease('更新清单结构无效');
    const metadata = payload as Record<string, unknown>;
    if (
      typeof metadata.version !== 'string' ||
      !/^\d+\.\d+\.\d+$/.test(metadata.version) ||
      typeof metadata.buildNumber !== 'number' ||
      !Number.isSafeInteger(metadata.buildNumber) ||
      metadata.buildNumber <= 0 ||
      metadata.packageName !== 'com.sesame.notes' ||
      metadata.abi !== 'arm64-v8a' ||
      typeof metadata.size !== 'number' ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size <= 0 ||
      typeof metadata.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(metadata.sha256) ||
      typeof metadata.notes !== 'string'
    )
      throw invalidRelease('更新清单字段无效');
    if (`v${metadata.version}` !== release.tagName || metadata.size !== apk.size)
      throw invalidRelease('更新清单与发布标签或安装包长度不一致');
    return metadata;
  }

  /** 取指定 ref 的 Release（'latest' 或版本标签），瞬时缓存降低 GitHub 调用次数。 */
  async function loadRelease(ref: string): Promise<ReleaseMetadata> {
    const repository = requireReleaseRepository();
    return cache.get(`release:${ref}`, async () => {
      // GitHub 只把 latest 放在 releases 下，按标签查询必须走 releases/tags/<tag>
      const path = ref === 'latest' ? 'latest' : `tags/${ref}`;
      const response = await fetch(`${GITHUB_API}/repos/${repository}/releases/${path}`, {
        headers: githubHeaders('application/vnd.github+json'),
        signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      });
      // 已发布的历史版本被删除时按不存在处理，避免把 404 说成上游故障
      if (response.status === 404) throw new ApiError(404, 'APP_RELEASE_NOT_FOUND', '安装包不存在');
      if (!response.ok) throw new ApiError(503, 'APP_RELEASE_UPSTREAM_FAILED', '更新源暂时不可用');
      const release = parseReleaseMetadata(await response.json());
      return release;
    });
  }

  /**
   * 带 Token 取单个附件响应；GitHub 先返回 302，由 fetch 自动跟随到签名地址。
   * 跨源跳转时 fetch 会剥离 authorization，Token 不会随跳转离开 GitHub；
   * range 会被保留，因此断点续传的 206 由上游直接给出。
   */
  async function openAsset(asset: ReleaseAsset, signal: AbortSignal, range?: string): Promise<Response> {
    try {
      const response = await fetch(asset.url, {
        headers: { ...githubHeaders('application/octet-stream'), ...(range ? { range } : {}) },
        signal,
      });
      if (!response.ok) {
        // 错误正文可能含签名地址或上游诊断信息，只关闭连接，不读取或转发内容。
        try {
          await response.body?.cancel();
        } catch (error) {
          app.log.warn({ err: error, status: response.status }, '发布附件错误响应关闭失败');
        }
        // 字节范围越界属于客户端可恢复状态，只有实际转发了 Range 才保留该响应。
        if (response.status !== 416 || !range)
          throw new ApiError(503, 'APP_RELEASE_UPSTREAM_FAILED', '更新源暂时不可用');
      }
      return response;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new Error('发布附件响应读取失败', { cause: error });
    }
  }

  app.get(
    '/api/v1/app/update.json',
    // 发布通道用固定 URL 直接拉取，不进入版本化业务契约，也不生成客户端方法。
    { schema: { hide: true }, onRequest: releaseRateLimit },
    async (request, reply) => {
      try {
        const release = await loadRelease('latest');
        // 元数据与安装包必须使用同一套正式命名，避免把其他渠道安装包配给正式元数据。
        const manifest = release.assets.find((asset) => asset.name === MANIFEST_ASSET_NAME);
        const apk = release.assets.find((asset) => asset.name === `Sesame-Notes-prod-${release.tagName}.apk`);
        if (!manifest || !apk) throw new ApiError(404, 'APP_RELEASE_NOT_PUBLISHED', '更新源尚未发布可用版本');

        let metadata: Record<string, unknown>;
        try {
          metadata = await cache.get(
            `manifest:${JSON.stringify([manifest.url, release.tagName, apk.url, apk.size])}`,
            async () => {
              const parsed: unknown = JSON.parse(
                await (await openAsset(manifest, AbortSignal.timeout(METADATA_TIMEOUT_MS))).text(),
              );
              return parseUpdateManifest(parsed, release, apk);
            },
          );
        } catch (error) {
          if (error instanceof ApiError) throw error;
          throw new ApiError(503, 'APP_RELEASE_INVALID', '更新源返回了无效数据', undefined, { cause: error });
        }

        // 客户端按元数据里的 url 下载，必须指向本服务；客户端只接受 https 地址。
        return { ...metadata, url: `https://${request.host}/api/v1/app/download/${apk.name}` };
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.statusCode === 429) reply.header('retry-after', '60');
          throw error;
        }
        throw new ApiError(503, 'APP_RELEASE_UPSTREAM_FAILED', '更新服务暂时不可用，请稍后重试', undefined, {
          cause: error,
        });
      }
    },
  );

  app.get(
    '/api/v1/app/download/:file',
    { schema: { hide: true }, onRequest: releaseRateLimit },
    async (request, reply) => {
      let releaseSlot: (() => void) | undefined;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      /** 响应完成、断开、超时和异常共用幂等清理，避免名额或上游连接残留。 */
      const cleanup = () => {
        clearTimeout(timer);
        controller.abort();
        releaseSlot?.();
      };
      try {
        const { file } = request.params as { file: string };
        const tag = APK_ASSET_NAME.exec(file)?.[1];
        if (file.length > 100 || !tag) throw new ApiError(404, 'APP_RELEASE_NOT_FOUND', '安装包不存在');
        if (request.method !== 'HEAD') releaseSlot = downloads.acquire(request.ip);
        reply.raw.once('close', cleanup);
        reply.raw.once('finish', cleanup);
        timer = setTimeout(() => {
          cleanup();
          reply.raw.destroy(new Error('安装包下载超时'));
        }, DOWNLOAD_TIMEOUT_MS);
        // 按文件名版本取对应 Release：发新版不会让旧版本链接失效，也不会误发最新版的文件
        const release = await loadRelease(tag);
        const apk = release.assets.find((asset) => asset.name === file);
        if (!apk) throw new ApiError(404, 'APP_RELEASE_NOT_FOUND', '安装包不存在');
        // 附件身份与长度共同生成强标识，系统下载恢复时据此校验文件仍为同一份。
        const etag = `"${createHash('sha256').update(`${apk.url}:${apk.size}`).digest('hex')}"`;
        const ifMatch = request.headers['if-match'];
        if (
          ifMatch &&
          ifMatch !== '*' &&
          !ifMatch
            .split(',')
            .map((value) => value.trim())
            .includes(etag)
        ) {
          throw new ApiError(412, 'APP_RELEASE_CHANGED', '安装包已变化，请重新下载');
        }

        // HEAD 只用于探测可用性：直接用 Release 元数据应答，不为不发送的正文打开上游连接。
        // 必须接管响应：Fastify 会把空正文的 HEAD content-length 覆盖成 0，让整包看起来是空文件。
        if (request.method === 'HEAD') {
          reply.hijack();
          reply.raw.writeHead(200, {
            'content-type': APK_CONTENT_TYPE,
            'content-length': String(apk.size),
            'accept-ranges': 'bytes',
            etag,
            'x-request-id': request.id,
          });
          reply.raw.end();
          return reply;
        }

        // 客户端中断下载或超时都立即释放上游连接，避免为已断开的下载继续占用带宽
        const range =
          request.headers['if-range'] && request.headers['if-range'] !== etag ? undefined : request.headers.range;
        // 仅转发单段字节范围，避免多段请求产生与 APK 类型不一致的 multipart 响应。
        if (range && (range.length > 100 || !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))) {
          reply.header('content-range', `bytes */${apk.size}`);
          throw new ApiError(416, 'APP_DOWNLOAD_RANGE_INVALID', '下载范围无效，请重新下载');
        }
        const upstream = await openAsset(apk, controller.signal, range);
        if (upstream.status === 416) {
          // 只保留未满足范围的合法总长度，错误正文由本服务生成。
          const contentRange = upstream.headers.get('content-range');
          if (contentRange && /^bytes \*\/\d+$/i.test(contentRange)) reply.header('content-range', contentRange);
          throw new ApiError(416, 'APP_DOWNLOAD_RANGE_INVALID', '下载范围无效，请重新下载');
        }
        const body = upstream.body;
        if (!body) throw new ApiError(503, 'APP_RELEASE_UPSTREAM_FAILED', '更新源暂时不可用');
        reply.header('content-type', APK_CONTENT_TYPE).header('accept-ranges', 'bytes').header('etag', etag);

        if (upstream.status === 206) {
          // 断点续传：范围与长度以上游为准，不能用整包长度覆盖
          const contentRange = upstream.headers.get('content-range');
          const contentLength = upstream.headers.get('content-length');
          reply.status(206);
          if (contentRange) reply.header('content-range', contentRange);
          if (contentLength) reply.header('content-length', contentLength);
        } else {
          // 长度取自 GitHub 元数据；客户端安装前仍会自行校验 size 与 sha256。
          reply.header('content-length', String(apk.size));
        }

        // 上游是 WHATWG 字节流，按异步迭代转为 Node 可读流交给 Fastify 转发，保持背压
        const stream = Readable.from(downloads.transfer(body, controller.signal), { objectMode: false });
        stream.once('error', (error) => {
          if (!controller.signal.aborted) request.log.warn({ err: error, request_id: request.id }, '安装包流传输失败');
          cleanup();
        });
        return reply.send(stream);
      } catch (error) {
        cleanup();
        if (error instanceof ApiError) {
          if (error.statusCode === 429) reply.header('retry-after', '60');
          throw error;
        }
        throw new ApiError(503, 'APP_RELEASE_UPSTREAM_FAILED', '下载暂时不可用，请稍后重试', undefined, {
          cause: error,
        });
      }
    },
  );
}
