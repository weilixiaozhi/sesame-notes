import { decodeJwt, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { signAccessToken, verifyAccessToken } from '../src/modules/auth/testing.js';

const config = loadConfig({
  DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
  JWT_SECRET: 'access-token-model-test-secret-at-least-32-bytes',
  STORAGE_PATH: 'Temp/access-token-model',
});
const claims = {
  userId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
  authGeneration: 'current-generation',
  credentialVersion: 2,
  scopes: ['profile:read'],
};

describe('应用访问令牌的身份声明', () => {
  it('签发和验证只保留应用身份与凭据版本', async () => {
    const token = await signAccessToken(claims, config);
    expect(decodeJwt(token)).not.toHaveProperty('is_admin');
    expect(await verifyAccessToken(token, config)).toEqual(claims);
  });

  it.each([undefined, null, '2', -1, 1.5])('拒绝非法凭据版本 %s', async (version) => {
    const token = await new SignJWT({
      device_id: claims.deviceId,
      auth_generation: claims.authGeneration,
      ...(version !== undefined ? { credential_version: version } : {}),
      scopes: claims.scopes,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(config.jwtSecret));
    await expect(verifyAccessToken(token, config)).rejects.toThrow('INVALID_ACCESS_TOKEN');
  });
});
