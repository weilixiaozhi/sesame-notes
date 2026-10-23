import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import type { AdminSession, Prisma, PrismaClient } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiConfig } from '../../shared/api-config.js';
import { ApiError } from '../../shared/errors.js';
import {
  DEFAULT_ADMIN_GROUP_ID,
  resolveAdminAuthorization,
  type AdminAccountWithGroup,
  type AdminIdentityType,
  type AdminPermission,
} from './admin-policy.js';
export type { AdminPermission } from './admin-policy.js';

const ADMIN_SESSION_COOKIE = '__Secure-sesame_admin_session';
const ADMIN_SECURITY_LOCK_KEY = 1_973_108_041;
export const ADMIN_FAILED_LOGIN_LIMIT = 5;
export const ADMIN_LOCKOUT_MS = 15 * 60_000;

const ADMIN_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 10_000 } as const;
const ADMIN_COOKIE_OPTIONS = {
  path: '/api/v1/admin',
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
} as const;
const SCRYPT_OPTIONS = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;
const PASSWORD_HASH_PREFIX = 'sesame-admin-scrypt$v1$131072$8$1';
const PASSWORD_HASH_PATTERN = /^sesame-admin-scrypt\$v1\$131072\$8\$1\$([\w-]{22})\$([\w-]{86})$/;
const SESSION_TOKEN_PATTERN = /^[\w-]{64}$/;

/** 此上下文只代表后台身份；不得赋给普通用户 request.auth。 */
type AdminAuthContext = {
  adminId: string;
  sessionId: string;
  username: string;
  email: string | null;
  phone: string | null;
  displayName: string;
  identityType: AdminIdentityType;
  group: AdminAccountWithGroup['group'];
  allowedPages: string[];
  authorizationVersion: string;
  permissions: readonly AdminPermission[];
  expiresAt: Date;
  /** 仅供事务内重验使用，不能作为 API 响应返回。 */
  tokenHash: string;
  sessionIdleTtlSeconds: number;
};

type AdminAuthenticationPolicy = Readonly<{ permission?: AdminPermission }>;

// 入口 onRoute 只能识别本模块生成的真实管理员守卫，普通用户守卫不能伪装成后台鉴权。
const ADMIN_AUTHENTICATION_HOOKS = new WeakMap<object, AdminAuthenticationPolicy>();

/** 从注册的守卫函数读取不可伪造的后台认证策略。 */
export function getAdminAuthenticationPolicy(hook: unknown): AdminAuthenticationPolicy | undefined {
  return typeof hook === 'function' ? ADMIN_AUTHENTICATION_HOOKS.get(hook) : undefined;
}

declare module 'fastify' {
  interface FastifyRequest {
    adminAuth?: AdminAuthContext;
  }
}

/** 先校验 ASCII 形态再转小写，拒绝手机号及 Unicode 相似字符。 */
export function normalizeAdminUsername(value: string): string {
  const username = value.trim();
  if (!/^[A-Z][\w.-]{3,31}$/i.test(username)) {
    throw new ApiError(
      400,
      'ADMIN_USERNAME_INVALID',
      '账号须为 4–32 位，以英文字母开头，仅含字母、数字、点、下划线或短横线',
    );
  }
  return username.toLowerCase();
}

/** 密码须为非空且可完整编码的字符串，散列时保留所有字符及空格。 */
export function validateAdminPassword(password: string): void {
  if (typeof password !== 'string' || password.length === 0) {
    throw new ApiError(400, 'ADMIN_PASSWORD_INVALID', '请输入密码');
  }
  // 未配对的代理码元编码为 UTF-8 时会丢失原值，必须避免不同输入产生相同凭据。
  if (!password.isWellFormed()) {
    throw new ApiError(400, 'ADMIN_PASSWORD_INVALID', '密码包含无效的字符编码');
  }
}

/* scrypt 每个任务约需 128 MiB。限制并发和排队，避免突发登录耗尽实例内存。 */
let activePasswordJobs = 0;
const passwordJobQueue: Array<() => void> = [];
const MAX_ACTIVE_PASSWORD_JOBS = 2;
const MAX_QUEUED_PASSWORD_JOBS = 8;

/** 通过有限并发队列执行固定成本密码派生，并可靠释放计算槽位。 */
async function derivePasswordKey(password: string, salt: Buffer): Promise<Buffer> {
  if (activePasswordJobs >= MAX_ACTIVE_PASSWORD_JOBS) {
    if (passwordJobQueue.length >= MAX_QUEUED_PASSWORD_JOBS) {
      throw new ApiError(503, 'ADMIN_AUTH_UNAVAILABLE', '后台登录验证暂时繁忙，请稍后重试');
    }
    await new Promise<void>((resolve) => passwordJobQueue.push(resolve));
  } else {
    activePasswordJobs += 1;
  }
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 64, SCRYPT_OPTIONS, (error, key) => {
        if (error) reject(error);
        else resolve(key);
      });
    });
  } finally {
    const next = passwordJobQueue.shift();
    if (next)
      next(); // 把当前槽位交给队首，不额外增加并发计数。
    else activePasswordJobs -= 1;
  }
}

/** 生成随机盐并输出固定版本的后台密码散列格式。 */
export async function hashAdminPassword(password: string): Promise<string> {
  validateAdminPassword(password);
  const salt = randomBytes(16);
  const key = await derivePasswordKey(password, salt);
  return `${PASSWORD_HASH_PREFIX}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/* 随机不可命中的期望值仍触发一次完整 scrypt；无需首次请求额外生成假密码哈希。 */
const DUMMY_PASSWORD_HASH = `${PASSWORD_HASH_PREFIX}$${randomBytes(16).toString('base64url')}$${randomBytes(64).toString('base64url')}`;

/** 为无效账号提供相同成本校验所需的占位散列。 */
export function dummyAdminPasswordHash(): string {
  return DUMMY_PASSWORD_HASH;
}

/** 只接受本后台的固定成本格式，绝不沿用普通用户的旧 scrypt/JWT 凭据。 */
export async function verifyAdminPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = PASSWORD_HASH_PATTERN.exec(encoded);
  const validInput = typeof password === 'string' && password.length > 0 && password.isWellFormed();
  const validHash = parsed !== null;
  const parts = parsed ?? PASSWORD_HASH_PATTERN.exec(DUMMY_PASSWORD_HASH)!;
  const expected = Buffer.from(parts[2]!, 'base64url');
  const salt = Buffer.from(parts[1]!, 'base64url');
  const key = await derivePasswordKey(validInput ? password : 'invalid-admin-password-input', salt);
  return validInput && validHash && expected.length === key.length && timingSafeEqual(expected, key);
}

/** 仅记录不可逆的登录标识摘要，用于限流及失败诊断。 */
export function adminLoginIdentifierDigest(identifier: string): string {
  return createHash('sha256').update('sesame-admin-login\0').update(identifier).digest('hex');
}

/** 生成具有充足随机性的后台不透明会话令牌。 */
export function createAdminSessionToken(): string {
  return randomBytes(48).toString('base64url');
}

/** 只将会话令牌摘要存入数据库，原始令牌仅保留于安全Cookie。 */
export function hashAdminSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 只读取格式有效的独立后台Cookie，不接受用户Bearer凭据。 */
export function readAdminSessionToken(request: FastifyRequest): string | null {
  // 同名 Cookie 来自不同域/路径时直接拒绝，避免依赖解析器的 first/last-wins 行为。
  const names = (request.headers.cookie ?? '')
    .split(';')
    .filter((part) => part.trim().startsWith(`${ADMIN_SESSION_COOKIE}=`));
  if (names.length > 1) return null;
  const token = request.cookies?.[ADMIN_SESSION_COOKIE];
  return typeof token === 'string' && SESSION_TOKEN_PATTERN.test(token) ? token : null;
}

/** 按安全Cookie属性下发后台会话并限定管理API路径。 */
export function setAdminSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(ADMIN_SESSION_COOKIE, token, {
    ...ADMIN_COOKIE_OPTIONS,
    expires: expiresAt,
    maxAge: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
  });
}

/** 用相同路径与属性使浏览器中的后台Cookie失效。 */
export function clearAdminSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(ADMIN_SESSION_COOKIE, ADMIN_COOKIE_OPTIONS);
}

/** 禁止后台响应及认证失败响应被浏览器或代理缓存。 */
export function setAdminNoStore(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
  reply.header('pragma', 'no-cache');
}

/** Cookie 写操作须通过来源白名单与不可由普通表单发送的自定义头双重校验。 */
export function verifyAdminWriteRequest(config: ApiConfig, options: { allowCliLogin?: boolean } = {}) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    setAdminNoStore(reply);
    const origin = request.headers.origin;
    const trustedOrigin =
      typeof origin === 'string' && origin !== 'null' && (config.adminOrigins ?? []).includes(origin);
    // CORS 可能还服务普通用户站点；读取后台也不能接受仅在用户白名单中的来源。
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (origin !== undefined && !trustedOrigin) {
        throw new ApiError(403, 'ORIGIN_DENIED', '后台请求来源不受信任');
      }
      return;
    }
    if (request.headers['x-admin-request'] !== '1') {
      throw new ApiError(403, 'ADMIN_REQUEST_REQUIRED', '后台请求缺少必要的安全标识');
    }
    const hasBrowserSignals =
      request.headers.cookie !== undefined ||
      Object.keys(request.headers).some((name) => name.startsWith('sec-fetch-'));
    if (options.allowCliLogin && origin === undefined && !hasBrowserSignals) return;
    if (!trustedOrigin) {
      throw new ApiError(403, 'ORIGIN_DENIED', '后台请求来源不受信任');
    }
  };
}

/** 所有后台身份/会话变更共用一把事务锁，禁止按 User 身份或用户会话降级。 */
export async function lockAdminSecurity(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${ADMIN_SECURITY_LOCK_KEY}::bigint)::text AS locked`;
}

/** 在当前安全事务中撤销指定后台用户的全部旧会话。 */
export async function revokeAdminSessions(tx: Prisma.TransactionClient, adminId: string): Promise<void> {
  await tx.adminSession.updateMany({
    where: { adminId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

type AdminSessionWithAccount = AdminSession & { admin: AdminAccountWithGroup };

/** 对有效授权状态生成稳定指纹，资料行版本和展示信息不参与工作区失权判断。 */
export function adminAuthorizationVersion(
  account: AdminAccountWithGroup,
  authorization: ReturnType<typeof resolveAdminAuthorization>,
): string {
  const state = {
    admin_id: account.id,
    identity_type: account.identityType,
    group_id: account.groupId,
    // 超管能力来自身份，所属组启停及业务配置不能改变其有效授权版本。
    group_enabled: account.identityType === 'standard_user' ? account.group.isEnabled : null,
    permissions: [...new Set(authorization.permissions)].sort(),
    allowed_pages: [...new Set(authorization.allowedPages)].sort(),
  };
  return `v1:${createHash('sha256').update(JSON.stringify(state)).digest('hex')}`;
}

/** 使用最新账号及组配置建立当前请求上下文。 */
function contextForSession(session: AdminSessionWithAccount, idleTtlSeconds: number): AdminAuthContext {
  const authorization = resolveAdminAuthorization(session.admin);
  return {
    adminId: session.admin.id,
    sessionId: session.id,
    username: session.admin.username,
    email: session.admin.email,
    phone: session.admin.phone,
    displayName: session.admin.displayName,
    identityType: session.admin.identityType as AdminIdentityType,
    group: session.admin.group,
    permissions: authorization.permissions,
    allowedPages: authorization.allowedPages,
    authorizationVersion: adminAuthorizationVersion(session.admin, authorization),
    expiresAt: session.expiresAt,
    tokenHash: session.tokenHash,
    sessionIdleTtlSeconds: idleTtlSeconds,
  };
}

/** 重读会话、账号及单组授权，拒绝失效账号或缺少动作权限的请求。 */
async function currentAdminSession(
  tx: Prisma.TransactionClient,
  tokenHash: string,
  idleTtlSeconds: number,
  permission: AdminPermission | undefined,
): Promise<AdminAuthContext> {
  const now = new Date();
  const session = await tx.adminSession.findUnique({
    where: { tokenHash },
    include: { admin: { include: { group: true } } },
  });
  if (
    !session ||
    session.revokedAt !== null ||
    !session.admin.isEnabled ||
    session.admin.deletedAt !== null ||
    session.expiresAt.getTime() <= now.getTime() ||
    session.lastSeenAt.getTime() + idleTtlSeconds * 1000 <= now.getTime()
  ) {
    throw new ApiError(401, 'ADMIN_UNAUTHORIZED', '后台登录状态已失效，请重新登录');
  }
  const context = contextForSession(session, idleTtlSeconds);
  if (permission !== undefined && !context.permissions.includes(permission)) {
    throw new ApiError(403, 'ADMIN_PERMISSION_DENIED', '当前后台用户无权执行此操作');
  }
  return context;
}

/** 从已通过独立后台守卫的请求中取得认证上下文。 */
export function requireAdminAuth(request: FastifyRequest): AdminAuthContext {
  if (!request.adminAuth) throw new ApiError(401, 'ADMIN_UNAUTHORIZED', '请先登录管理后台');
  return request.adminAuth;
}

/** 用安全事务更新会话活动时间并按当前身份和组权限执行认证。 */
export function authenticateAdmin(config: ApiConfig, prisma: PrismaClient, permission?: AdminPermission) {
  const verifyWrite = verifyAdminWriteRequest(config);
  const hook = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    setAdminNoStore(reply);
    request.adminAuth = undefined;
    await verifyWrite(request, reply);
    const token = readAdminSessionToken(request);
    if (!token) throw new ApiError(401, 'ADMIN_UNAUTHORIZED', '请先登录管理后台');
    try {
      request.adminAuth = await prisma.$transaction(async (tx) => {
        await lockAdminSecurity(tx);
        const context = await currentAdminSession(
          tx,
          hashAdminSessionToken(token),
          config.adminSessionIdleTtlSeconds ?? 1800,
          permission,
        );
        await tx.adminSession.update({ where: { id: context.sessionId }, data: { lastSeenAt: new Date() } });
        return context;
      }, ADMIN_TRANSACTION_OPTIONS);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      request.log.error({ err: error, request_id: request.id }, '后台会话安全状态暂时无法读取');
      throw new ApiError(503, 'ADMIN_AUTH_UNAVAILABLE', '后台登录验证暂时不可用，请稍后重试');
    }
  };
  ADMIN_AUTHENTICATION_HOOKS.set(
    hook,
    Object.freeze({
      permission,
    }),
  );
  return hook;
}

/** 在真实写入之前重新验证会话与当前身份及用户组授权，防止鉴权和写入之间被撤权。 */
export async function withAdminMutation<T>(
  prisma: PrismaClient,
  request: FastifyRequest,
  permission: AdminPermission,
  fn: (tx: Prisma.TransactionClient, auth: AdminAuthContext) => Promise<T>,
): Promise<T> {
  const previous = requireAdminAuth(request);
  return await prisma.$transaction(async (tx) => {
    await lockAdminSecurity(tx);
    const auth = await currentAdminSession(tx, previous.tokenHash, previous.sessionIdleTtlSeconds, permission);
    if (auth.adminId !== previous.adminId || auth.sessionId !== previous.sessionId) {
      throw new ApiError(401, 'ADMIN_UNAUTHORIZED', '后台登录状态已失效，请重新登录');
    }
    request.adminAuth = auth;
    return await fn(tx, auth);
  }, ADMIN_TRANSACTION_OPTIONS);
}

/** 显式白名单序列化，避免上下文内 tokenHash 等服务器字段出现在响应。 */
export function adminIdentity(auth: AdminAuthContext) {
  return {
    id: auth.adminId,
    username: auth.username,
    email: auth.email,
    phone: auth.phone,
    display_name: auth.displayName,
    identity_type: auth.identityType,
    group_id: auth.group.id,
    group: {
      id: auth.group.id,
      name: auth.group.name,
      is_enabled: auth.group.isEnabled,
      version: auth.group.version,
      is_default: auth.group.id === DEFAULT_ADMIN_GROUP_ID,
    },
    is_enabled: true,
    allowed_pages: [...auth.allowedPages],
    authorization_version: auth.authorizationVersion,
    permissions: [...auth.permissions],
  };
}

/** 将新会话转换成不含凭据及服务器内部字段的认证响应。 */
export function adminSessionResponse(session: AdminSessionWithAccount, config: ApiConfig) {
  const auth = contextForSession(session, config.adminSessionIdleTtlSeconds ?? 1800);
  return { admin: adminIdentity(auth), expires_at: auth.expiresAt.toISOString() };
}
