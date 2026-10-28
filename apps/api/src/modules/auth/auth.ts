import { createHash } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';

import type { ApiConfig } from '../../shared/api-config.js';
import { createMultiKeyRateLimit } from '../../shared/rate-limit.js';
import { ApiError } from '../../shared/errors.js';
import { execute, executor } from '../../shared/execute.js';
import { AnyUuidSchema, UuidSchema } from '../../shared/contracts/scalars.js';
import { currentAuthGeneration } from '../../shared/server-generations.js';
import { acquireSyncTransactionLock, type SyncTransaction } from '../../shared/sync-transaction.js';
import { authenticate, requireAuth, requireScopes } from './guards.js';
import { allocateSesameNumber, defaultNickname } from './identity.js';
import { normalizeE164Phone, PhoneInvalidError } from './phone.js';
import { currentSessionAccess } from './session-access.js';
import { lockAccountSessions, terminateRefreshTokens } from './session-lifecycle.js';
import {
  createRefreshToken,
  dummyPasswordHash,
  hashOpaqueToken,
  hashPassword,
  signAccessToken,
  verifyPassword,
} from './security.js';

/** 认证域共用的 500 失败码，捕获与日志由公共执行器负责。 */
const executeAuth = executor('PASSWORD_CHANGE_FAILED');

/**
 * 轮换宽限窗口：刷新时服务端先作废旧令牌再下发新令牌，客户端要等响应回来才落盘。
 * 安装更新（系统强制停进程）等场景落在窗口内时，设备会只剩已作废的令牌；
 * 若该设备的后继令牌已签发，允许旧令牌在窗口内继续换发，避免用户被迫重新登录。
 */
const ROTATION_GRACE_MS = 60_000;

const DeviceInputSchema = Type.Object({
  // 客户端稳定安装 UUID：同一安装在不同账号下对应不同服务端 device id
  installation_id: AnyUuidSchema,
  name: Type.String({ minLength: 1, maxLength: 128 }),
  platform: Type.String({ minLength: 1, maxLength: 32 }),
  app_version: Type.Optional(Type.String({ maxLength: 64 })),
  os_version: Type.Optional(Type.String({ maxLength: 64 })),
  device_model: Type.Optional(Type.String({ maxLength: 128 })),
});

const SessionSchema = Type.Object({
  access_token: Type.String(),
  refresh_token: Type.String(),
  token_type: Type.Literal('Bearer'),
  expires_in: Type.Integer(),
  device_id: UuidSchema,
  scopes: Type.Array(Type.String()),
  user: Type.Object({
    user_id: UuidSchema,
    sesame_number: Type.String(),
    display_name: Type.Union([Type.String(), Type.Null()]),
    avatar_url: Type.Union([Type.String(), Type.Null()]),
    avatar_version: Type.Integer({ minimum: 0 }),
    // 完整手机号仅本人可见
    phone: Type.String(),
    gender: Type.Union([Type.Literal('UNSPECIFIED'), Type.Literal('MALE'), Type.Literal('FEMALE')]),
  }),
});

type SessionUser = {
  id: string;
  phoneE164: string;
  credentialVersion: number;
  sesameNumber: string;
  isEnabled: boolean;
  profile: {
    displayName: string | null;
    avatarFileId: string | null;
    avatarVersion: number;
    gender: string;
  } | null;
};

type DeviceMetadataInput = {
  platform?: string;
  app_version?: string;
  os_version?: string;
  device_model?: string;
};

type DeviceInput = DeviceMetadataInput & {
  installation_id: string;
  name: string;
  platform: string;
};

/** 芝麻号碰撞完整重试上限：数据库唯一约束识别碰撞，新事务重试 */
const MAX_SESAME_RETRIES = 5;

/** 注册事务的排队与执行窗口：连接池偏小或并发突发时排队等待，避免默认 2s 直接失败 */
const REGISTER_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 10_000 } as const;

/** 事务没能启动（拿不到连接）的重试上限：此类失败没有产生任何副作用，可安全重试 */
const MAX_TRANSACTION_START_RETRIES = 3;

/** 组合根提供账号创建时的业务初始化，认证模块只传递已创建的账号和设备身份。 */
type AccountCreatedInitializer = (tx: SyncTransaction, auth: { userId: string; deviceId: string }) => Promise<void>;

/** 同时注册移动端与浏览器会话；浏览器刷新令牌只通过独立 Cookie 传递。 */
export function registerAuthRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  config: ApiConfig,
  onAccountCreated: AccountCreatedInitializer,
): void {
  const authRateLimited = createAuthenticationRateLimit(config);
  registerAuthClientRoutes(app, prisma, config, false, authRateLimited, onAccountCreated);
  registerAuthClientRoutes(app, prisma, config, true, authRateLimited, onAccountCreated);
}

/** 共用认证事务，按客户端隔离路由、响应与 Cookie，避免业务实现分叉。 */
function registerAuthClientRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  config: ApiConfig,
  browser: boolean,
  authRateLimited: ReturnType<typeof createAuthenticationRateLimit>,
  onAccountCreated: AccountCreatedInitializer,
): void {
  const prefix = browser ? '/api/v1/auth/browser' : '/api/v1/auth';
  const cookieName = 'browser_refresh_token';
  const responseSchema = browser ? Type.Omit(SessionSchema, ['refresh_token']) : SessionSchema;
  // 设备资料沿用额外正文内容的兼容边界，只有处理器识别出的受控字段会进入设备记录。
  const refreshBodySchema = browser
    ? Type.Optional(Type.Object({ device: Type.Optional(Type.Unknown()) }, { additionalProperties: false }))
    : Type.Object({ refresh_token: Type.String({ minLength: 32 }), device: Type.Optional(Type.Unknown()) });
  const logoutBodySchema = browser
    ? Type.Optional(Type.Object({}, { additionalProperties: false }))
    : Type.Object({ refresh_token: Type.String({ minLength: 32 }) });
  const verifyCookieOrigin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.header('cache-control', 'no-store');
    const origin = request.headers.origin;
    // 无浏览器来源、Cookie 和 Fetch Metadata 的原生客户端沿用正文令牌路径。
    if (
      !browser &&
      origin === undefined &&
      request.headers.cookie === undefined &&
      request.headers['sec-fetch-site'] === undefined
    )
      return;
    // 精确匹配配置来源；不信任 Host/代理头，也不把不透明来源 null 当作白名单。
    if (!origin || origin === 'null' || !config.corsOrigins.includes(origin)) {
      throw new ApiError(403, 'ORIGIN_DENIED', '请求来源不受信任');
    }
  };

  // 敏感接口限流：按真实客户端 IP 与带服务端密钥的规范化手机号摘要双维度计数，
  // 防「单 IP 批量试探」与「单手机号跨 IP 试探」；key 与日志都不含完整手机号

  app.post(
    `${prefix}/register`,
    {
      onRequest: verifyCookieOrigin,
      preHandler: authRateLimited,
      schema: {
        tags: ['auth'],
        body: Type.Object({
          country_code: Type.String({ minLength: 2, maxLength: 5 }),
          phone: Type.String({ minLength: 1, maxLength: 32 }),
          password: Type.String({ maxLength: 128 }),
          device: DeviceInputSchema,
        }),
        response: { 201: responseSchema },
      },
    },
    async (request, reply) => {
      try {
        const body = request.body as { country_code: string; phone: string; password: string; device: DeviceInput };
        const session = await createMobileAccount(
          prisma,
          config,
          body,
          request,
          browser ? 'web' : 'app',
          onAccountCreated,
        );
        if (browser) setRefreshCookie(reply, session.refresh_token, config, cookieName, prefix);
        await reply.status(201).send(sessionResponse(session, browser));
      } catch (error) {
        if (error instanceof ApiError) throw error;
        request.log.error({ err: error, request_id: request.id }, '注册失败');
        throw new ApiError(500, 'REGISTER_FAILED', '注册失败，请稍后重试');
      }
    },
  );

  app.post(
    `${prefix}/login`,
    {
      onRequest: verifyCookieOrigin,
      preHandler: authRateLimited,
      schema: {
        tags: ['auth'],
        body: Type.Object({
          country_code: Type.String({ minLength: 2, maxLength: 5 }),
          phone: Type.String({ minLength: 1, maxLength: 32 }),
          password: Type.String({ minLength: 1, maxLength: 128 }),
          device: DeviceInputSchema,
        }),
        response: { 200: responseSchema },
      },
    },
    async (request, reply) =>
      execute(
        request,
        '登录',
        async () => {
          const body = request.body as {
            country_code: string;
            phone: string;
            password: string;
            device: DeviceInput;
          };
          const user = await resolveLoginUser(prisma, body);
          // 不存在的手机号、禁用账号与错误密码返回完全一致的状态码、code 和文案，防止枚举；
          // 账号不存在时也执行一次真实 scrypt 校验，让响应耗时不可区分
          if (!user) {
            await verifyPassword(body.password, await dummyPasswordHash());
            throw new ApiError(401, 'INVALID_CREDENTIALS', '手机号或密码错误');
          }
          const session = await prisma.$transaction(async (tx) => {
            await lockAccountSessions(tx, user.id);
            // 手机号、密码与启用状态必须在账号锁内重读，等待期间发生换绑、改密或禁用时不能按旧快照签发。
            const current = await tx.user.findUnique({ where: { id: user.id }, include: { profile: true } });
            const passwordOk = await verifyPassword(
              body.password,
              current?.passwordHash ?? (await dummyPasswordHash()),
            );
            if (!current || current.phoneE164 !== user.phoneE164 || !current.isEnabled || !passwordOk) {
              throw new ApiError(401, 'INVALID_CREDENTIALS', '手机号或密码错误');
            }
            return await createSession(tx, config, current, body.device, request.ip);
          });
          if (browser) setRefreshCookie(reply, session.refresh_token, config, cookieName, prefix);
          await reply.send(sessionResponse(session, browser));
        },
        'LOGIN_FAILED',
      ),
  );

  app.post(
    `${prefix}/refresh`,
    {
      onRequest: verifyCookieOrigin,
      preHandler: authRateLimited,
      schema: {
        tags: ['auth'],
        body: refreshBodySchema,
        response: { 200: responseSchema },
      },
    },
    async (request, reply) => {
      try {
        // 浏览器会话只读取安全 Cookie，应用会话只读取经过 Schema 校验的正文令牌。
        const metadata = parseDeviceMetadata((request.body as { device?: unknown } | undefined)?.device);
        const oldToken = browser
          ? request.cookies[cookieName]
          : (request.body as { refresh_token: string }).refresh_token;
        if (!oldToken) throw new ApiError(401, 'REFRESH_TOKEN_REQUIRED', '登录状态已失效，请重新登录');
        const tokenHash = hashOpaqueToken(oldToken);
        const target = await prisma.refreshToken.findUnique({
          where: { tokenHash },
          select: { userId: true },
        });
        if (!target) throw new ApiError(401, 'INVALID_REFRESH_TOKEN', '登录状态已失效，请重新登录');
        const session = await prisma.$transaction(async (tx) => {
          await lockAccountSessions(tx, target.userId);
          // 锁前只定位账号；令牌、设备和账号资格全部在锁内重读，防止撤销后签发新令牌。
          const now = new Date();
          const stored = await tx.refreshToken.findUnique({
            where: { tokenHash },
            include: { user: { include: { profile: true } }, device: true },
          });
          // 签发 generation 不等于当前 generation 的令牌一律失效
          const authGeneration = await currentAuthGeneration(tx);
          const usable =
            stored != null &&
            stored.authGeneration === authGeneration &&
            stored.expiresAt > now &&
            !stored.device.revokedAt &&
            stored.user.isEnabled;
          // 已被轮换（同设备存在未撤销的后继令牌）且撤销时间在宽限窗口内时继续放行；
          // 明确终止同时截止 expiresAt，只有正常轮换的旧令牌可以进入宽限。
          const withinRotationGrace =
            usable &&
            stored.revokedAt != null &&
            now.getTime() - stored.revokedAt.getTime() <= ROTATION_GRACE_MS &&
            (await tx.refreshToken.findFirst({
              where: {
                userId: stored.userId,
                deviceId: stored.deviceId,
                revokedAt: null,
                expiresAt: { gt: now },
                authGeneration,
                createdAt: { gte: stored.revokedAt },
              },
              select: { id: true },
            })) != null;
          if (!usable || (stored.revokedAt != null && !withinRotationGrace)) {
            throw new ApiError(401, 'INVALID_REFRESH_TOKEN', '登录状态已失效，请重新登录');
          }

          const newToken = createRefreshToken();
          const revoked = await tx.refreshToken.updateMany({
            where: { id: stored.id, revokedAt: null },
            data: { revokedAt: now },
          });
          // 宽限路径里旧令牌已在上一次轮换时撤销，命中 0 行属预期。
          if (!revoked.count && !withinRotationGrace) {
            throw new ApiError(401, 'INVALID_REFRESH_TOKEN', '登录状态已失效，请重新登录');
          }
          await tx.refreshToken.create({
            data: {
              userId: stored.userId,
              deviceId: stored.deviceId,
              tokenHash: hashOpaqueToken(newToken),
              expiresAt: new Date(now.getTime() + config.refreshTokenTtlSeconds * 1_000),
              authGeneration,
              // PostgreSQL 默认 now() 是事务开始时间，显式使用锁后的轮换时刻以保持后继判定一致。
              createdAt: now,
            },
          });
          // 设备归属完全取自已验证的刷新凭据，客户端正文只能更新非空可变资料。
          await tx.device.update({
            where: { id: stored.deviceId },
            data: { ...deviceMetadataUpdateData(metadata), lastSeenAt: now, lastIp: request.ip },
          });
          return await buildSession(config, stored.user, stored.deviceId, newToken, authGeneration);
        });
        if (browser) setRefreshCookie(reply, session.refresh_token, config, cookieName, prefix);
        await reply.send(sessionResponse(session, browser));
      } catch (error) {
        if (error instanceof ApiError) throw error;
        request.log.error({ err: error, request_id: request.id }, '刷新令牌轮换失败');
        throw new ApiError(500, 'TOKEN_REFRESH_FAILED', '登录状态刷新失败，请重新登录');
      }
    },
  );

  if (!browser)
    app.patch(
      '/api/v1/auth/password',
      {
        // 修改密码纳入认证敏感接口限流（无手机号维度，按 IP 计数）
        preHandler: [authRateLimited, authenticate(config, prisma), requireScopes('profile:read', 'profile:write')],
        schema: {
          tags: ['auth'],
          body: Type.Object({
            current_password: Type.String({ minLength: 1, maxLength: 128 }),
            new_password: Type.String({ maxLength: 128 }),
          }),
          response: { 204: Type.Null() },
        },
      },
      async (request, reply) =>
        executeAuth(request, '修改密码', async () => {
          const auth = requireAuth(request);
          const body = request.body as { current_password: string; new_password: string };
          // 新密码散列不依赖当前账号状态，先计算以缩短会话锁持有时间。
          const nextPasswordHash = body.new_password ? await hashPassword(body.new_password) : null;
          await prisma.$transaction(async (tx) => {
            await lockAccountSessions(tx, auth.userId);
            if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '请先登录');
            const user = await tx.user.findUnique({ where: { id: auth.userId } });
            if (!user || !(await verifyPassword(body.current_password, user.passwordHash))) {
              throw new ApiError(400, 'CURRENT_PASSWORD_INVALID', '当前密码错误');
            }
            if (!nextPasswordHash) throw new ApiError(400, 'PASSWORD_INVALID', '请输入密码');
            await tx.user.update({
              where: { id: auth.userId },
              data: { passwordHash: nextPasswordHash },
            });
            // 撤销其他设备的 Refresh Token，当前设备保持登录
            await terminateRefreshTokens(tx, auth.userId, { deviceId: { not: auth.deviceId } });
          });
          await reply.status(204).send();
        }),
    );

  app.post(
    `${prefix}/logout`,
    {
      onRequest: verifyCookieOrigin,
      preHandler: authenticate(config, prisma),
      schema: {
        tags: ['auth'],
        body: logoutBodySchema,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      try {
        const auth = requireAuth(request);
        const token = browser ? request.cookies[cookieName] : (request.body as { refresh_token: string }).refresh_token;
        // 出示的刷新令牌确定本次登出所属会话；只有仍有效的同设备会话才能整组撤销。
        const terminated = await prisma.$transaction(async (tx) => {
          await lockAccountSessions(tx, auth.userId);
          if (!token) return false;
          const stored = await tx.refreshToken.findUnique({ where: { tokenHash: hashOpaqueToken(token) } });
          if (
            !stored ||
            stored.userId !== auth.userId ||
            stored.deviceId !== auth.deviceId ||
            stored.authGeneration !== auth.authGeneration ||
            stored.authGeneration !== (await currentAuthGeneration(tx)) ||
            stored.expiresAt <= new Date()
          ) {
            return false;
          }
          // 轮换仅标记 revokedAt，仍有效的轮换旧令牌与所有后继一起终止，避免宽限重试复活。
          await terminateRefreshTokens(tx, auth.userId, { deviceId: auth.deviceId });
          return true;
        });
        // 迟到的旧会话登出不能覆盖新登录写入的 Cookie；未携带 Cookie 时仅清理浏览器状态。
        if (browser && (terminated || !token)) reply.clearCookie(cookieName, { path: prefix });
        await reply.status(204).send();
      } catch (error) {
        request.log.error({ err: error, request_id: request.id }, '退出登录失败');
        throw new ApiError(500, 'LOGOUT_FAILED', '退出登录失败，请稍后重试');
      }
    },
  );
}

/** 按手机号解析登录用户；不存在或禁用的账号与错误密码走同一响应路径，防止枚举。 */
async function resolveLoginUser(
  prisma: PrismaClient,
  body: { country_code: string; phone: string },
): Promise<(SessionUser & { passwordHash: string }) | null> {
  try {
    const phoneE164 = normalizeE164Phone(body.country_code, body.phone);
    return await prisma.user.findUnique({
      where: { phoneE164 },
      include: { profile: true },
    });
  } catch (error) {
    if (error instanceof PhoneInvalidError) throw new ApiError(400, 'PHONE_INVALID', '请输入有效的手机号');
    if (error instanceof ApiError) throw error;
    throw new Error('登录用户解析失败', { cause: error });
  }
}

/** 账号、设备、会话和业务初始化在同一事务完成；任一步失败整体回滚，唯一冲突从新事务重试。 */
async function createMobileAccount(
  prisma: PrismaClient,
  config: ApiConfig,
  body: { country_code: string; phone: string; password: string; device: DeviceInput },
  request: FastifyRequest,
  registrationPlatform: 'app' | 'web',
  onAccountCreated: AccountCreatedInitializer,
) {
  try {
    let phoneE164: string;
    try {
      phoneE164 = normalizeE164Phone(body.country_code, body.phone);
    } catch (error) {
      if (error instanceof PhoneInvalidError) throw new ApiError(400, 'PHONE_INVALID', '请输入有效的手机号');
      throw error;
    }
    if (!body.password) throw new ApiError(400, 'PASSWORD_INVALID', '请输入密码');
    const passwordHash = await hashPassword(body.password);

    let startTimeouts = 0;
    for (let attempt = 1; ; attempt++) {
      try {
        return await prisma.$transaction(async (tx) => {
          // 同步锁先于手机号锁及业务写入，初始化事件的游标顺序与提交顺序一致。
          const locked = await acquireSyncTransactionLock(tx);
          // 同手机号并发串行化：确定性 advisory lock 使第二个事务在锁释放后
          // 看到已存在账号并返回 409，数据库唯一索引是最终并发防线
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${phoneE164}, 0))`;
          const existing = await tx.user.findUnique({ where: { phoneE164 } });
          if (existing) throw new ApiError(409, 'PHONE_ALREADY_REGISTERED', '该手机号已注册');
          const user = await tx.user.create({
            data: {
              phoneE164,
              sesameNumber: allocateSesameNumber(),
              passwordHash,
              profile: { create: { displayName: defaultNickname() } },
            },
            include: { profile: true },
          });
          // 由服务端注册入口确定来源，不采用客户端可填写的设备名称或平台；和账号一起提交、一起回滚。
          const registration = await tx.productAnalyticsEvent.updateMany({
            where: { eventId: user.id, kind: 'registration' },
            data: { platform: registrationPlatform },
          });
          if (registration.count !== 1) throw new Error('账号注册统计事件缺失或不唯一');
          // JWT 预签名在事务内完成：签名失败时事务回滚，数据库零残留
          const session = await createSession(tx, config, user, body.device, request.ip);
          // 只在注册事务初始化业务目录，真实设备已存在，初始化失败不会向外返回会话。
          await onAccountCreated(locked, { userId: user.id, deviceId: session.device_id });
          return session;
        }, REGISTER_TRANSACTION_OPTIONS);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        // 事务没能启动（连接池排队超时）：重试等待，避免并发注册直接返回 500
        if (isTransactionStartTimeout(error)) {
          startTimeouts += 1;
          request.log.warn({ startTimeouts, request_id: request.id }, '注册事务排队超时，重新排队');
          if (startTimeouts >= MAX_TRANSACTION_START_RETRIES) throw error;
          continue;
        }
        if (isUniqueViolation(error)) {
          const target = uniqueViolationTarget(error);
          if (target.some((field) => field === 'sesame_number' || field === 'sesameNumber')) {
            request.log.warn({ attempt, request_id: request.id }, '芝麻号碰撞，开始新事务重试');
            if (attempt >= MAX_SESAME_RETRIES) {
              throw new ApiError(500, 'SESAME_NUMBER_ALLOCATION_FAILED', '注册失败，请稍后重试');
            }
            continue;
          }
          if (target.some((field) => field === 'phone_e164' || field === 'phoneE164')) {
            // 并发窗口内的手机号唯一约束兜底
            throw new ApiError(409, 'PHONE_ALREADY_REGISTERED', '该手机号已注册');
          }
        }
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    request.log.error({ err: error, request_id: request.id }, '手机号注册事务失败');
    throw new ApiError(500, 'REGISTER_FAILED', '注册失败，请稍后重试');
  }
}

/**
 * 创建或更新设备并签发一组新的访问与刷新令牌。
 *
 * 设备按 (user_id, installation_id) upsert：同一安装在同一账号下复用同一
 * 服务端 device id，不同账号各自拥有独立 device（互不冲突）。
 */
async function createSession(
  tx: Prisma.TransactionClient,
  config: ApiConfig,
  user: SessionUser,
  input: DeviceInput,
  ip: string,
) {
  try {
    const refreshToken = createRefreshToken();
    // 令牌携带签发时的 auth generation：轮换后整体失效
    const authGeneration = await currentAuthGeneration(tx);
    const device = await upsertDevice(tx, user.id, input, ip);
    // 密码认证建立独立会话，明确终止同安装的旧令牌及轮换后继，供迟到登出识别归属。
    await terminateRefreshTokens(tx, user.id, { deviceId: device.id });
    await tx.refreshToken.create({
      data: {
        userId: user.id,
        deviceId: device.id,
        tokenHash: hashOpaqueToken(refreshToken),
        expiresAt: new Date(Date.now() + config.refreshTokenTtlSeconds * 1_000),
        authGeneration,
      },
    });
    return await buildSession(config, user, device.id, refreshToken, authGeneration);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('会话创建失败', { cause: error });
  }
}

/** 按账号与安装标识保存设备，更新字段只允许修改设备资料和活动状态。 */
async function upsertDevice(tx: Prisma.TransactionClient, userId: string, input: DeviceInput, ip: string) {
  try {
    const mutableDeviceData = deviceUpdateData(input, ip);
    return await tx.device.upsert({
      where: { userId_installationId: { userId, installationId: input.installation_id } },
      create: { ...mutableDeviceData, userId, installationId: input.installation_id },
      update: { ...mutableDeviceData, revokedAt: null },
    });
  } catch (error) {
    throw new Error('设备保存失败', { cause: error });
  }
}

/** 仅构造设备可变资料；账号、安装标识和主键不参与更新，避免设备跨账号转移。 */
function deviceUpdateData(input: DeviceInput, ip: string) {
  return {
    ...deviceMetadataUpdateData(input),
    name: input.name.trim(),
    platform: input.platform.trim().toLowerCase(),
    lastIp: ip,
    lastSeenAt: new Date(),
  };
}

/** 缺失和空白资料保留已知值，旧客户端或读取失败不会清空设备资料。 */
function deviceMetadataUpdateData(input?: DeviceMetadataInput) {
  return {
    platform: normalizeDeviceMetadataValue(input?.platform)?.toLowerCase(),
    appVersion: normalizeDeviceMetadataValue(input?.app_version),
    osVersion: normalizeDeviceMetadataValue(input?.os_version),
    deviceModel: normalizeDeviceMetadataValue(input?.device_model),
  };
}

/** 仅解析实际可用的非唯一设备资料，任何身份字段、未知键或不合法资料都被忽略。 */
function parseDeviceMetadata(raw: unknown): DeviceMetadataInput | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  return {
    platform: deviceMetadataField(input.platform, 32),
    app_version: deviceMetadataField(input.app_version, 64),
    os_version: deviceMetadataField(input.os_version, 64),
    device_model: deviceMetadataField(input.device_model, 128),
  };
}

/** 类型和长度不合法的资料不能阻止会话刷新，也不能替换服务端已经记录的值。 */
function deviceMetadataField(raw: unknown, maxLength: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return value && value.length <= maxLength ? value : undefined;
}

/** 空白仅表示资料不可用，不构成清除服务器既有资料的指令。 */
function normalizeDeviceMetadataValue(value?: string): string | undefined {
  return value?.trim() || undefined;
}

/** 生成客户端会话响应；用户对象包含本人资料与完整手机号。 */
async function buildSession(
  config: ApiConfig,
  user: SessionUser,
  deviceId: string,
  refreshToken: string,
  authGeneration: string,
) {
  const scopes = ['sync:read', 'sync:write', 'profile:read', 'profile:write'];
  const accessToken = await signAccessToken(
    {
      userId: user.id,
      deviceId,
      authGeneration,
      credentialVersion: user.credentialVersion,
      scopes,
    },
    config,
  );
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer' as const,
    expires_in: config.accessTokenTtlSeconds,
    device_id: deviceId,
    scopes,
    user: {
      user_id: user.id,
      sesame_number: user.sesameNumber,
      display_name: user.profile?.displayName ?? null,
      avatar_url: user.profile?.avatarFileId
        ? `/api/v1/profile/avatar/${user.id}?v=${user.profile.avatarVersion}`
        : null,
      avatar_version: user.profile?.avatarVersion ?? 0,
      phone: user.phoneE164,
      gender: user.profile?.gender ?? 'UNSPECIFIED',
    },
  };
}

/** Prisma 没能在窗口内取得连接启动事务（P2028）：事务未产生副作用，可以安全重试。 */
function isTransactionStartTimeout(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2028' &&
    `${String(error.meta?.error ?? '')}${error.message}`.includes('Unable to start a transaction')
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && Array.isArray(error.meta?.target)
  );
}

/** 提取唯一约束冲突涉及的字段名（兼容字段名与数据库列名两种形态）。 */
function uniqueViolationTarget(error: unknown): string[] {
  if (error instanceof Prisma.PrismaClientKnownRequestError && Array.isArray(error.meta?.target)) {
    return error.meta.target.map((field) => String(field));
  }
  return [];
}

/** 设置浏览器会话的安全 Cookie，刷新令牌只由浏览器 Cookie 路径承载。 */
function setRefreshCookie(reply: FastifyReply, token: string, config: ApiConfig, name: string, path: string): void {
  reply.setCookie(name, token, {
    path,
    httpOnly: true,
    secure: config.deploymentEnvironment === 'prod' || process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: config.refreshTokenTtlSeconds,
  });
}

/** 主动移除浏览器响应中的刷新令牌，避免依赖序列化器来隐藏敏感字段。 */
function sessionResponse(session: Awaited<ReturnType<typeof buildSession>>, browser: boolean) {
  const { refresh_token: refreshToken, ...publicSession } = session;
  return browser ? publicSession : { ...publicSession, refresh_token: refreshToken };
}

/** 所有认证入口共享同一限流器，避免切换移动端与浏览器路径扩大尝试额度。 */
function createAuthenticationRateLimit(config: ApiConfig) {
  return createMultiKeyRateLimit(config.authRateLimitMax, 60_000, (request) => {
    const body = request.body as { country_code?: string; phone?: string } | undefined;
    if (!body?.country_code || !body.phone) return null;
    try {
      const phoneE164 = normalizeE164Phone(body.country_code, body.phone);
      // 先派生专用摘要密钥，再合并规范手机号计算限流标识，桶中只保留摘要。
      const digestKey = createHash('sha256').update(`${config.jwtSecret}:phone-rate-limit`).digest();
      return createHash('sha256').update(digestKey).update(phoneE164, 'utf8').digest('hex');
    } catch {
      return null;
    }
  });
}
