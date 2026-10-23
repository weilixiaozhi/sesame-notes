import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { jwtVerify, SignJWT } from 'jose';

import type { ApiConfig } from '../../shared/api-config.js';
import { ApiError } from '../../shared/errors.js';

const scrypt = promisify(scryptCallback);
const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_HASH_PATTERN = /^scrypt:([\w-]{22}):([\w-]{86})$/;

export type AccessClaims = {
  userId: string;
  deviceId: string;
  authGeneration: string;
  credentialVersion: number;
  scopes: string[];
};

/** 登录防枚举用的等成本假哈希：账号不存在时也执行一次真实 scrypt 校验， 使"手机号不存在"与"密码错误"的响应耗时不可区分。惰性生成一次并复用。 */
let dummyPasswordHashValue: string | undefined;

/** 返回可验证的 dummy scrypt 哈希；与真实哈希同格式、同成本。 */
export async function dummyPasswordHash(): Promise<string> {
  try {
    dummyPasswordHashValue ??= await hashPassword(randomUUID());
    return dummyPasswordHashValue;
  } catch (error) {
    throw new Error('登录占位哈希生成失败', { cause: error });
  }
}

/** 使用内置 scrypt 对密码做带随机盐的强哈希，避免增加原生扩展依赖。 */
export async function hashPassword(password: string): Promise<string> {
  try {
    if (!password.isWellFormed()) throw new ApiError(400, 'PASSWORD_INVALID', '密码包含无效的字符编码');
    const salt = randomBytes(16);
    const key = (await scrypt(password, salt, PASSWORD_KEY_LENGTH)) as Buffer;
    return `scrypt:${salt.toString('base64url')}:${key.toString('base64url')}`;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('密码加密失败', { cause: error });
  }
}

/** 使用恒定时间比较验证密码，降低哈希比较泄漏风险。 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    // 未配对代理码元编码时会变成替换字符，不能让不同原文验证为同一个密码。
    if (!password.isWellFormed()) return false;
    const parts = PASSWORD_HASH_PATTERN.exec(encoded);
    if (!parts) return false;
    const salt = Buffer.from(parts[1]!, 'base64url');
    const expected = Buffer.from(parts[2]!, 'base64url');
    // 只接受签发器的固定长度和规范编码，损坏的摘要不能缩短派生长度或形成空值比较。
    if (`scrypt:${salt.toString('base64url')}:${expected.toString('base64url')}` !== encoded) return false;
    const actual = (await scrypt(password, salt, PASSWORD_KEY_LENGTH)) as Buffer;
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** 签发短期 Access Token，只放鉴权所需的最少声明。 */
export async function signAccessToken(claims: AccessClaims, config: ApiConfig): Promise<string> {
  try {
    return await new SignJWT({
      device_id: claims.deviceId,
      auth_generation: claims.authGeneration,
      credential_version: claims.credentialVersion,
      scopes: claims.scopes,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuedAt()
      .setExpirationTime(`${config.accessTokenTtlSeconds}s`)
      .sign(new TextEncoder().encode(config.jwtSecret));
  } catch (error) {
    throw new Error('访问令牌签发失败', { cause: error });
  }
}

/** 验证 Access Token 并还原强类型身份上下文。 */
export async function verifyAccessToken(token: string, config: ApiConfig): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(config.jwtSecret), { algorithms: ['HS256'] });
    if (
      !payload.sub ||
      typeof payload.device_id !== 'string' ||
      typeof payload.auth_generation !== 'string' ||
      typeof payload.credential_version !== 'number' ||
      !Number.isSafeInteger(payload.credential_version) ||
      payload.credential_version < 0 ||
      !Array.isArray(payload.scopes) ||
      payload.scopes.some((scope) => typeof scope !== 'string')
    )
      throw new Error('令牌声明不完整');
    return {
      userId: payload.sub,
      deviceId: payload.device_id,
      authGeneration: payload.auth_generation,
      credentialVersion: payload.credential_version,
      scopes: payload.scopes as string[],
    };
  } catch (error) {
    throw new Error('INVALID_ACCESS_TOKEN', { cause: error });
  }
}

/** 生成只向客户端展示一次的随机 Refresh Token。 */
export function createRefreshToken(): string {
  try {
    return randomBytes(48).toString('base64url');
  } catch (error) {
    throw new Error('刷新令牌生成失败', { cause: error });
  }
}

/** 将不透明令牌转成数据库可安全索引的固定长度哈希。 */
export function hashOpaqueToken(token: string): string {
  try {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  } catch (error) {
    throw new Error('令牌哈希失败', { cause: error });
  }
}
