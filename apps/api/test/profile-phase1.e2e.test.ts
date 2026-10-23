import { testStoragePath } from './test-storage-path.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';

const DATABASE_URL = testFixtureDatabaseUrl();
const API_BASE = '/api/v1';

const config: ApiConfig = {
  databaseUrl: DATABASE_URL,
  jwtSecret: 'e2e-test-secret-that-is-at-least-32-bytes-long',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  storagePath: testStoragePath('profile-phase1'),
  exchangeRateUpstream: 'https://api.frankfurter.dev',
  exchangeRateCacheTtlSeconds: 43_200,
  githubReleaseToken: '',
  port: 8080,
  host: '127.0.0.1',
  corsOrigins: [],
  rateLimitMax: 1000,
  authRateLimitMax: 1000,
  syncRetentionMinCursor: 0,
  trustProxyCidrs: [],
};

let prisma: PrismaClient;
let app: ReturnType<typeof buildApp>;

/** 生成每次调用唯一且可登录的手机号（+86 区号，11 位） */
function uniquePhone(): string {
  return `138${randomUUID().replace(/\D/g, '').slice(0, 8)}`;
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function api(
  method: 'get' | 'post' | 'patch' | 'delete' | 'put',
  path: string,
  body?: Record<string, unknown>,
  token?: string,
) {
  const response = await app.inject({
    method,
    url: `${API_BASE}${path}`,
    payload: body,
    headers: {
      ...(token ? bearer(token) : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
  });
  return {
    status: response.statusCode,
    json: (): unknown => (response.body ? JSON.parse(response.body) : null),
    body: response.body,
    headers: response.headers,
    rawPayload: response.rawPayload,
  };
}

/** 返回注册时的完整会话身份，便于核验同一设备在改密后的刷新资格。 */
async function registerUser(): Promise<{
  token: string;
  refreshToken: string;
  deviceId: string;
  userId: string;
  phone: string;
}> {
  try {
    const phone = uniquePhone();
    const res = await api('post', '/auth/register', {
      country_code: '+86',
      phone,
      password: 'password-123456',
      device: { installation_id: randomUUID(), name: 'e2e-device', platform: 'e2e' },
    });
    expect(res.status).toBe(201);
    const session = res.json() as {
      access_token: string;
      refresh_token: string;
      device_id: string;
      user: { user_id: string };
    };
    return {
      token: session.access_token,
      refreshToken: session.refresh_token,
      deviceId: session.device_id,
      userId: session.user.user_id,
      phone,
    };
  } catch (cause) {
    throw new Error('个人资料测试账号注册失败', { cause });
  }
}

/** 最小合法 PNG（1×1 透明像素），仅用于头像链路的 MIME/体积行为验证 */
const MINI_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

beforeAll(async () => {
  prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
  app = buildApp({ logger: false, config, prisma });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('切片三：个人资料与修改密码（需求锚点）', () => {
  it('个人资料只保留支出设置，读取与修改均不接受收入颜色字段', async () => {
    const { token } = await registerUser();
    const me = await api('get', '/profile/me', undefined, token);
    expect(me.status).toBe(200);
    expect.soft(me.json()).not.toHaveProperty('income_is_red');

    const patched = await api('patch', '/profile/me', { income_is_red: false }, token);
    expect(patched.status).toBe(400);
    expect(patched.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('profile/me 返回本人资料和完整手机号，不含脱敏手机号或 account 字段', async () => {
    const { token, userId, phone } = await registerUser();
    const me = await api('get', '/profile/me', undefined, token);
    expect(me.status).toBe(200);
    const body = me.json() as Record<string, unknown>;
    expect(body.user_id).toBe(userId);
    expect(body.sesame_number).toMatch(/^[1-9]\d{8}$/);
    expect(body.display_name).toMatch(/^芝麻仔\d{6}$/);
    expect(body.gender).toBe('UNSPECIFIED');
    expect(body.phone).toMatch(/^\+86\d{11}$/);
    expect(body).not.toHaveProperty('phone_masked');
    // 完整手机号仅本人可见（产品要求完全显示）
    expect(body.phone).toBe(`+86${phone}`);
    expect(JSON.stringify(body)).not.toContain('account');
  });

  it('本人可修改昵称与性别；非法昵称/性别返回对应错误码', async () => {
    const { token, userId } = await registerUser();

    const nick = await api('patch', '/profile/me', { display_name: '  新昵称  ' }, token);
    expect(nick.status).toBe(200);
    expect((nick.json() as { display_name: string }).display_name).toBe('新昵称');

    const gender = await api('patch', '/profile/me', { gender: 'MALE' }, token);
    expect(gender.status).toBe(200);
    expect((gender.json() as { gender: string }).gender).toBe('MALE');
    // 数据库事实：gender 已落库
    const row = await prisma.userProfile.findUniqueOrThrow({ where: { userId } });
    expect(row.gender).toBe('MALE');

    // 名称含 NUL → 400 DISPLAY_NAME_INVALID
    const badNick = await api('patch', '/profile/me', { display_name: 'a\u0000b' }, token);
    expect(badNick.status).toBe(400);
    expect((badNick.json() as { code: string }).code).toBe('DISPLAY_NAME_INVALID');

    // 昵称不可置空（注册即分配默认昵称，账号昵称恒非空）
    const emptyNick = await api('patch', '/profile/me', { display_name: '' }, token);
    expect(emptyNick.status).toBe(400);
    expect((emptyNick.json() as { code: string }).code).toBe('DISPLAY_NAME_INVALID');
    const blankNick = await api('patch', '/profile/me', { display_name: '   ' }, token);
    expect(blankNick.status).toBe(400);
    expect((blankNick.json() as { code: string }).code).toBe('DISPLAY_NAME_INVALID');
    const nullNick = await api('patch', '/profile/me', { display_name: null }, token);
    expect(nullNick.status).toBe(400);

    // 置空被拒后昵称保持原值
    const after = await api('get', '/profile/me', undefined, token);
    expect((after.json() as { display_name: string }).display_name).toBe('新昵称');

    // 非法性别 → 400 GENDER_INVALID
    const badGender = await api('patch', '/profile/me', { gender: 'ALIEN' }, token);
    expect(badGender.status).toBe(400);
    expect((badGender.json() as { code: string }).code).toBe('GENDER_INVALID');
  });

  it('昵称采用公共 100 码点上限并能完整落库，拒绝纯不可见名称', async () => {
    const { token, userId } = await registerUser();
    const name = '🏠'.repeat(100);
    const result = await api('patch', '/profile/me', { display_name: name }, token);
    expect(result.status).toBe(200);
    expect((await prisma.userProfile.findUniqueOrThrow({ where: { userId } })).displayName).toBe(name);
    expect((await api('patch', '/profile/me', { display_name: '🏠'.repeat(101) }, token)).status).toBe(400);
    expect((await api('patch', '/profile/me', { display_name: '\u200B' }, token)).status).toBe(400);
  });

  it('不能修改手机号与芝麻号（契约不接受这些字段，值保持不变）', async () => {
    const { token } = await registerUser();
    const before = (await api('get', '/profile/me', undefined, token)).json() as {
      sesame_number: string;
      phone: string;
    };
    // 契约字段不在 PATCH body schema 中：携带即被拒
    const attempt = await api('patch', '/profile/me', { phone: '13900000000', sesame_number: '123456789' }, token);
    expect(attempt.status).toBe(400);
    const after = (await api('get', '/profile/me', undefined, token)).json() as {
      sesame_number: string;
      phone: string;
    };
    expect(after.sesame_number).toBe(before.sesame_number);
    expect(after.phone).toBe(before.phone);
  });

  it('修改密码：旧密码错误 400，成功后旧密码失效、新密码可登录、其他设备 Refresh Token 撤销', async () => {
    const { token, refreshToken, deviceId, phone } = await registerUser();
    // 另一设备登录拿 Refresh Token
    const second = await api('post', '/auth/login', {
      country_code: '+86',
      phone,
      password: 'password-123456',
      device: { installation_id: randomUUID(), name: 'second', platform: 'e2e' },
    });
    const secondRefresh = (second.json() as { refresh_token: string }).refresh_token;
    expect(second.status).toBe(200);

    // 当前密码错误
    const wrongCurrent = await api(
      'patch',
      '/auth/password',
      { current_password: 'nope', new_password: 'new-pass' },
      token,
    );
    expect(wrongCurrent.status).toBe(400);
    expect((wrongCurrent.json() as { code: string }).code).toBe('CURRENT_PASSWORD_INVALID');

    // 新密码为空
    const emptyNew = await api(
      'patch',
      '/auth/password',
      { current_password: 'password-123456', new_password: '' },
      token,
    );
    expect(emptyNew.status).toBe(400);
    expect((emptyNew.json() as { code: string }).code).toBe('PASSWORD_INVALID');

    // 修改成功
    const change = await api(
      'patch',
      '/auth/password',
      {
        current_password: 'password-123456',
        new_password: 'brand-new-password',
      },
      token,
    );
    expect(change.status).toBe(204);

    // 旧密码登录失败、新密码登录成功
    const oldLogin = await api('post', '/auth/login', {
      country_code: '+86',
      phone,
      password: 'password-123456',
      device: { installation_id: randomUUID(), name: 'e2e', platform: 'e2e' },
    });
    expect(oldLogin.status).toBe(401);
    const newLogin = await api('post', '/auth/login', {
      country_code: '+86',
      phone,
      password: 'brand-new-password',
      device: { installation_id: randomUUID(), name: 'e2e', platform: 'e2e' },
    });
    expect(newLogin.status).toBe(200);

    // 其他设备 Refresh Token 已撤销；当前设备刷新仍可用
    const otherRefresh = await api('post', '/auth/refresh', { refresh_token: secondRefresh });
    expect(otherRefresh.status).toBe(401);
    expect(otherRefresh.json()).toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });

    // 使用改密前注册时签发的当前设备刷新令牌，验证改密不会强制本人设备重新登录。
    const myRefresh = await api('post', '/auth/refresh', { refresh_token: refreshToken });
    expect(myRefresh.status).toBe(200);
    expect((myRefresh.json() as { device_id: string }).device_id).toBe(deviceId);
  });

  it('修改密码接受单字符和 128 字符密码，拒绝超长输入且不改变已保存密码', async () => {
    const { token, phone } = await registerUser();
    let current = 'password-123456';
    for (const next of ['1', 'a'.repeat(128)]) {
      const changed = await api('patch', '/auth/password', { current_password: current, new_password: next }, token);
      expect(changed.status).toBe(204);
      const loggedIn = await api('post', '/auth/login', {
        country_code: '+86',
        phone,
        password: next,
        device: { installation_id: randomUUID(), name: 'password-rule-check', platform: 'e2e' },
      });
      expect(loggedIn.status).toBe(200);
      current = next;
    }
    const rejected = await api(
      'patch',
      '/auth/password',
      { current_password: current, new_password: 'a'.repeat(129) },
      token,
    );
    expect(rejected.status).toBe(400);
    const unchanged = await api('post', '/auth/login', {
      country_code: '+86',
      phone,
      password: current,
      device: { installation_id: randomUUID(), name: 'password-unchanged-check', platform: 'e2e' },
    });
    expect(unchanged.status).toBe(200);
  });

  it('上传/下载/恢复默认头像：上传成功递增版本，DELETE 幂等 204', async () => {
    const { token, userId } = await registerUser();
    const upload = await api(
      'put',
      '/profile/avatar',
      { content_type: 'image/png', data_base64: MINI_PNG_BASE64 },
      token,
    );
    expect(upload.status).toBe(200);
    const meta = upload.json() as { avatar_version: number; avatar_url: string };
    expect(meta.avatar_version).toBe(1);
    expect(meta.avatar_url).toContain('/api/v1/profile/avatar/');

    // 再次上传递增版本
    const again = await api(
      'put',
      '/profile/avatar',
      { content_type: 'image/png', data_base64: MINI_PNG_BASE64 },
      token,
    );
    expect((again.json() as { avatar_version: number }).avatar_version).toBe(2);

    // 本人下载
    const download = await api('get', `/profile/avatar/${userId}`, undefined, token);
    expect(download.status).toBe(200);
    expect(String(download.headers['content-type'])).toContain('image/png');
    // 服务端统一经 sharp 规范化重编码，断言 PNG 魔数而非逐字节相等
    expect(download.rawPayload.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

    // 恢复默认（删除）：幂等 204
    const remove = await api('delete', '/profile/avatar', undefined, token);
    expect(remove.status).toBe(204);
    const removeAgain = await api('delete', '/profile/avatar', undefined, token);
    expect(removeAgain.status).toBe(204);
    // 删除后本人下载 404
    const afterRemove = await api('get', `/profile/avatar/${userId}`, undefined, token);
    expect(afterRemove.status).toBe(404);
    expect((afterRemove.json() as { code: string }).code).toBe('AVATAR_NOT_FOUND');
  });
});
