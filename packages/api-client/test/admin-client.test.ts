import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApiClient, ApiError, unwrap } from '../src/index.js';

/** 构造带标准 JSON 类型的测试响应。 */
function response(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const creationKey = '11111111-1111-4111-8111-111111111111';
const localized = { zh: '测试内容', zh_hant: '測試內容', en: 'Test content' };
const commonContent = {
  name: localized,
  description: localized,
  difficulty: 'beginner' as const,
  goals: { zh: ['力量'], zh_hant: ['力量'], en: ['Strength'] },
};
const bannerBody = {
  slot: 'fitness-plan-library' as const,
  image_id: 'a'.repeat(64),
  target: 'fitness-exercises' as const,
  target_id: null,
  sort_order: 0,
};
const exerciseBody = {
  content: {
    name_zh: '测试动作',
    name_zh_hant: '測試動作',
    name_en: 'Test exercise',
    body_part: 'chest',
    equipment: 'body_weight',
    target: 'pectorals',
    secondary_muscles: [],
    instructions_zh: ['保持稳定'],
    instructions_zh_hant: ['保持穩定'],
    instructions_en: ['Keep stable'],
    attribution: '',
    gif_asset: '',
  },
};
const templateBody = {
  content: {
    ...commonContent,
    duration_minutes: 30,
    equipment: ['body_weight'],
    exercises: [
      {
        exercise_id: 'test-exercise',
        sets: 3,
        reps: 10,
        weight_kg: null,
        weight_mode: 'body_weight' as const,
        rest_seconds: 30,
      },
    ],
  },
};
const planBody = {
  content: { ...commonContent, cycle_days: 1, days: [{ day_index: 0, template_id: creationKey }] },
};
const taxonomyBody = { name: localized, reason: '新增测试分类' };
const accountBody = { username: 'operator', password: 'test-only-password', display_name: '测试管理员' };
const groupBody = { name: '测试用户组' };
const creationCases = [
  {
    name: 'Banner',
    path: '/api/v1/admin/banners',
    body: bannerBody,
    send: (api: AdminApiClient, key?: string) => api.adminBanners.create(bannerBody, key),
  },
  {
    name: '动作',
    path: '/api/v1/admin/fitness/exercises',
    body: exerciseBody,
    send: (api: AdminApiClient, key?: string) => api.adminFitnessExercises.create(exerciseBody, key),
  },
  {
    name: '模板',
    path: '/api/v1/admin/fitness/templates',
    body: templateBody,
    send: (api: AdminApiClient, key?: string) => api.adminFitnessTemplates.create(templateBody, key),
  },
  {
    name: '计划',
    path: '/api/v1/admin/fitness/plans',
    body: planBody,
    send: (api: AdminApiClient, key?: string) => api.adminFitnessPlans.create(planBody, key),
  },
  {
    name: '身体部位',
    path: '/api/v1/admin/fitness/taxonomies/body_part',
    body: taxonomyBody,
    send: (api: AdminApiClient, key?: string) => api.adminFitnessTaxonomies.create('body_part', taxonomyBody, key),
  },
  {
    name: '器械',
    path: '/api/v1/admin/fitness/taxonomies/equipment',
    body: taxonomyBody,
    send: (api: AdminApiClient, key?: string) => api.adminFitnessTaxonomies.create('equipment', taxonomyBody, key),
  },
  {
    name: '后台用户',
    path: '/api/v1/admin/accounts',
    body: accountBody,
    send: (api: AdminApiClient, key?: string) => api.adminAccounts.create(accountBody, key),
  },
  {
    name: '用户组',
    path: '/api/v1/admin/groups',
    body: groupBody,
    send: (api: AdminApiClient, key?: string) => api.adminGroups.create(groupBody, key),
  },
];

describe('后台客户端凭证边界', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(creationCases)('$name 新增传递本次固定幂等标识且保留凭证边界', async ({ path, body, send }) => {
    const fetch = vi.fn().mockResolvedValue(response(201, { id: creationKey }));
    vi.stubGlobal('fetch', fetch);
    const api = new AdminApiClient({ baseUrl: 'https://admin.example' });
    await send(api, creationKey);
    expect(fetch).toHaveBeenCalledOnce();
    const sent = fetch.mock.calls[0]![0] as Request;
    expect(sent.url).toBe(`https://admin.example${path}`);
    expect(sent.method).toBe('POST');
    expect(sent.headers.get('idempotency-key')).toBe(creationKey);
    expect(sent.headers.get('x-admin-request')).toBe('1');
    expect(sent.headers.has('authorization')).toBe(false);
    expect(sent.credentials).toBe('include');
    expect(await sent.json()).toEqual(body);
  });

  it('幂等标识不泄漏到后续读取、登录或未指定标识的创建请求', async () => {
    const fetch = vi.fn().mockImplementation(async () => response(200, {}));
    vi.stubGlobal('fetch', fetch);
    const api = new AdminApiClient({ baseUrl: 'https://admin.example' });
    await api.adminBanners.create(bannerBody, creationKey);
    await api.adminGroups.list();
    await api.adminGroups.create(groupBody);
    await api.adminAuth.login({ username: 'operator', password: 'test-only-password' });
    expect(fetch).toHaveBeenCalledTimes(4);
    const requests = fetch.mock.calls.map(([request]) => request as Request);
    expect(requests[0]!.headers.get('idempotency-key')).toBe(creationKey);
    for (const request of requests.slice(1)) expect(request.headers.has('idempotency-key')).toBe(false);
  });

  it.each([401, 409, 503])('携带幂等标识的创建收到%s仍只发送一次', async (status) => {
    const fetch = vi.fn().mockResolvedValue(response(status, { code: 'CREATION_FAILED', message: '新增未完成' }));
    vi.stubGlobal('fetch', fetch);
    const api = new AdminApiClient({ baseUrl: 'https://admin.example' });
    await expect(api.adminBanners.create(bannerBody, creationKey)).rejects.toMatchObject({ status });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('创建结果未知时保留调用方幂等标识且不自动重放网络请求', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('连接已断开'));
    vi.stubGlobal('fetch', fetch);
    const api = new AdminApiClient({ baseUrl: 'https://admin.example' });
    await expect(api.adminBanners.create(bannerBody, creationKey)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
    expect((fetch.mock.calls[0]![0] as Request).headers.get('idempotency-key')).toBe(creationKey);
  });

  it('Banner 累计统计不发送日期或筛选参数', async () => {
    const fetch = vi.fn().mockResolvedValue(response(200, { scope: 'total', items: [] }));
    vi.stubGlobal('fetch', fetch);
    const api = new AdminApiClient({ baseUrl: 'https://admin.example' });
    await api.adminBanners.statistics();
    const sent = fetch.mock.calls[0]![0] as Request;
    expect(sent.url).toBe('https://admin.example/api/v1/admin/banners/statistics');
    expect(sent.method).toBe('GET');
  });

  it('Banner 保存携带版本与管理写标记，冲突不会自动覆盖或重放', async () => {
    const fetch = vi.fn().mockResolvedValue(response(409, { code: 'BANNER_VERSION_CONFLICT', message: '配置已变化' }));
    vi.stubGlobal('fetch', fetch);
    const api = new AdminApiClient({ baseUrl: 'https://admin.example' });
    const id = '11111111-1111-4111-8111-111111111111';
    const body = {
      version: 3,
      slot: 'fitness-plan-library' as const,
      image_id: 'a'.repeat(64),
      target: 'fitness-exercises' as const,
      target_id: null,
      sort_order: 0,
    };
    await expect(api.adminBanners.update(id, body)).rejects.toMatchObject({ status: 409 });
    expect(fetch).toHaveBeenCalledOnce();
    const sent = fetch.mock.calls[0]![0] as Request;
    expect(sent.url).toBe(`https://admin.example/api/v1/admin/banners/${id}`);
    expect(sent.method).toBe('PATCH');
    expect(sent.credentials).toBe('include');
    expect(sent.headers.get('X-Admin-Request')).toBe('1');
    expect(sent.headers.has('authorization')).toBe(false);
    expect(await sent.json()).toEqual(body);
  });

  it('后台会话读取的空 200 不能确认有效身份', async () => {
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(null, { status: 200, headers: { 'x-request-id': 'admin-empty' } })),
      );
      const api = new AdminApiClient({ baseUrl: 'https://admin.example' });
      const confirmIdentity = vi.fn();
      await expect(api.adminAuth.me().then(confirmIdentity)).rejects.toMatchObject({
        status: 200,
        code: 'EMPTY_RESPONSE',
        requestId: 'admin-empty',
      });
      expect(confirmIdentity).not.toHaveBeenCalled();
    } catch (cause) {
      throw new Error('后台客户端把缺失的会话正文作为有效身份交付', { cause });
    }
  });

  it('Cookie 请求剔除用户令牌，敏感响应不缓存且不接受重定向', async () => {
    const fetch = vi.fn().mockResolvedValue(response(200, { admin: {} }));
    vi.stubGlobal('fetch', fetch);
    const api = new AdminApiClient({ baseUrl: 'https://admin.example' });
    await api.client.GET('/api/v1/admin/auth/me', { headers: { authorization: 'Bearer product-user-token' } });
    const request = fetch.mock.calls[0]![0] as Request;
    expect(request.headers.has('authorization')).toBe(false);
    expect(request.credentials).toBe('include');
    expect(request.cache).toBe('no-store');
    expect(request.redirect).toBe('error');
  });

  it('后台凭证不能通过底层客户端发送到应用用户接口', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const api = new AdminApiClient({ baseUrl: 'https://admin.example' });
    await expect(api.client.GET('/api/v1/health')).rejects.toMatchObject({ code: 'ADMIN_REQUEST_SCOPE' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('登录写请求包含来源保护头，错误直接交给表单且没有刷新重放', async () => {
    const fetch = vi.fn().mockResolvedValue(response(401, { code: 'ADMIN_LOGIN_FAILED', message: '认证失败' }));
    const onUnauthorized = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const api = new AdminApiClient({ baseUrl: 'https://admin.example', onUnauthorized });
    await expect(
      api.adminAuth.login({ username: 'operator', password: 'a test-only password' }),
    ).rejects.toBeInstanceOf(ApiError);
    expect((fetch.mock.calls[0]![0] as Request).headers.get('x-admin-request')).toBe('1');
    expect(fetch).toHaveBeenCalledOnce();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('失效会话通知清缓存，写请求仅发送一次', async () => {
    const fetch = vi.fn().mockResolvedValue(response(401, { code: 'ADMIN_UNAUTHORIZED', message: '会话失效' }));
    const onUnauthorized = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const api = new AdminApiClient({ baseUrl: 'https://admin.example', onUnauthorized });
    await expect(
      api.adminAuth.changePassword({ old_password: 'an old test password', new_password: 'a new test password' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('会话状态读取支持外部取消', async () => {
    const abort = new AbortController();
    let request: Request | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request) => {
        request = input;
        return response(200, { admin: {} });
      }),
    );
    const api = new AdminApiClient({ baseUrl: 'https://admin.example' });
    const result = await api.client.GET('/api/v1/admin/auth/me', { signal: abort.signal });
    expect(unwrap(result)).toEqual({ admin: {} });
    abort.abort();
    expect(request?.signal.aborted).toBe(true);
  });

  it('旧会话迟到的401不会退出已重新登录的新会话', async () => {
    const old = Promise.withResolvers<Response>();
    const onUnauthorized = vi.fn();
    const fetch = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(response(200, { admin: {} }));
    vi.stubGlobal('fetch', fetch);
    const api = new AdminApiClient({ baseUrl: 'https://admin.example', onUnauthorized });
    const expiredRequest = api.adminAuth.me().catch((error: unknown) => error);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await api.adminAuth.login({ username: 'operator', password: 'a test-only password' });
    old.resolve(response(401, { code: 'ADMIN_UNAUTHORIZED', message: '旧会话失效' }));
    expect(await expiredRequest).toMatchObject({ status: 401 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
