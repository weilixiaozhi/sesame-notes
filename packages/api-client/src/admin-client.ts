import type { paths } from './generated/api.js';
import { ApiClient, unwrap, type ResponseValidator } from './client.js';
import { ApiError } from './errors.js';

type Query<Operation> = Operation extends { parameters: { query?: infer Value } } ? NonNullable<Value> : never;
type Body<Operation> = Operation extends { requestBody?: { content: { 'application/json': infer Value } } }
  ? Value
  : never;

interface AdminApiClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  validateResponse?: ResponseValidator;
  onUnauthorized?: () => void;
}

/** 独立后台客户端只访问管理接口，携带 Cookie，并将所有写操作保留为单次请求。 */
export class AdminApiClient extends ApiClient {
  private sessionGeneration = 0;
  private readonly requestGenerations = new WeakMap<Request, number>();

  constructor(options: AdminApiClientOptions) {
    super({
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
      validateResponse: options.validateResponse,
      getAccessToken: async () => null,
      credentials: 'include',
    });
    const origin = new URL(options.baseUrl).origin;
    this.client.use({
      /** 限制凭证发送范围，屏蔽用户令牌，避免浏览器缓存包含个人资料的响应。 */
      onRequest: ({ request, schemaPath }) => {
        const url = new URL(request.url);
        if (url.origin !== origin || !schemaPath.startsWith('/api/v1/admin/')) {
          throw new ApiError(0, 'ADMIN_REQUEST_SCOPE', '后台请求地址无效');
        }
        request.headers.delete('authorization');
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) request.headers.set('X-Admin-Request', '1');
        const scoped = new Request(request, { credentials: 'include', cache: 'no-store', redirect: 'error' });
        this.requestGenerations.set(scoped, this.sessionGeneration);
        return scoped;
      },
      /** 会话失效通知页面清理内存；登录失败留在当前表单展示，不刷新或重放请求。 */
      onResponse: ({ response, schemaPath, request }) => {
        if (
          response.status === 401 &&
          schemaPath !== '/api/v1/admin/auth/login' &&
          this.requestGenerations.get(request) === this.sessionGeneration
        )
          options.onUnauthorized?.();
      },
    });
  }

  /** 会话边界改变后，迟到的旧请求不能再次触发新会话退出。 */
  invalidateSessionRequests(): void {
    this.sessionGeneration += 1;
  }

  readonly adminBanners = {
    /** 读取应用固定入口的图片、目标和当前修订。 */
    list: async (signal?: AbortSignal) => unwrap(await this.client.GET('/api/v1/admin/banners', { signal })),
    /** 按北京时间范围查询当前入口配置的真实曝光与点击。 */
    statistics: async (query: Query<paths['/api/v1/admin/banners/statistics']['get']>, signal?: AbortSignal) =>
      unwrap(await this.client.GET('/api/v1/admin/banners/statistics', { params: { query }, signal })),
    /** 新增同一位置的一张轮播图片。 */
    create: async (body: Body<paths['/api/v1/admin/banners']['post']>) =>
      unwrap(await this.client.POST('/api/v1/admin/banners', { body })),
    /** 按当前修订保存轮播图片与独立跳转目标。 */
    update: async (banner_id: string, body: Body<paths['/api/v1/admin/banners/{banner_id}']['patch']>) =>
      unwrap(await this.client.PATCH('/api/v1/admin/banners/{banner_id}', { params: { path: { banner_id } }, body })),
    /** 删除一张自定义图片；最后一张删除后应用使用内置入口。 */
    remove: async (banner_id: string, body: Body<paths['/api/v1/admin/banners/{banner_id}']['delete']>) =>
      unwrap(await this.client.DELETE('/api/v1/admin/banners/{banner_id}', { params: { path: { banner_id } }, body })),
    /** 比对位置内完整修订快照后恢复默认，避免覆盖他人新增图片。 */
    reset: async (
      slot: paths['/api/v1/admin/banners/{slot}/reset']['post']['parameters']['path']['slot'],
      body: Body<paths['/api/v1/admin/banners/{slot}/reset']['post']>,
    ) => unwrap(await this.client.POST('/api/v1/admin/banners/{slot}/reset', { params: { path: { slot } }, body })),
    /** 查询可跳转的官方计划或模板，权限沿用 Banner 管理。 */
    targets: async (query: Query<paths['/api/v1/admin/banners/targets']['get']>, signal?: AbortSignal) =>
      unwrap(await this.client.GET('/api/v1/admin/banners/targets', { params: { query }, signal })),
    /** 上传经过服务端校验的图片，保存配置后才对应用生效。 */
    upload: async (body: Body<paths['/api/v1/admin/banners/media']['post']>) =>
      unwrap(await this.client.POST('/api/v1/admin/banners/media', { body })),
  };

  readonly adminAuth = {
    /** 获取当前后台会话及最新授权。 */
    me: async (signal?: AbortSignal) => unwrap(await this.client.GET('/api/v1/admin/auth/me', { signal })),
    /** 使用独立登录账号与密码建立后台会话。 */
    login: async (body: Body<paths['/api/v1/admin/auth/login']['post']>) => {
      this.invalidateSessionRequests();
      return unwrap(await this.client.POST('/api/v1/admin/auth/login', { body }));
    },
    /** 撤销当前会话并清除后台 Cookie。 */
    logout: async () => {
      this.invalidateSessionRequests();
      return unwrap(await this.client.POST('/api/v1/admin/auth/logout'));
    },
    /** 校验原密码并设置新密码，服务端撤销该账号全部会话。 */
    changePassword: async (body: Body<paths['/api/v1/admin/auth/password']['post']>) =>
      unwrap(await this.client.POST('/api/v1/admin/auth/password', { body })),
  };

  readonly adminAccounts = {
    /** 按服务端条件分页查询后台用户。 */
    list: async (query: Query<paths['/api/v1/admin/accounts']['get']> = {}, signal?: AbortSignal) =>
      unwrap(await this.client.GET('/api/v1/admin/accounts', { params: { query }, signal })),
    /** 新建具有单个用户组归属的后台用户。 */
    create: async (body: Body<paths['/api/v1/admin/accounts']['post']>) =>
      unwrap(await this.client.POST('/api/v1/admin/accounts', { body })),
    /** 使用版本校验修改显示名称、启用状态或用户组。 */
    update: async (admin_id: string, body: Body<paths['/api/v1/admin/accounts/{admin_id}']['patch']>) =>
      unwrap(await this.client.PATCH('/api/v1/admin/accounts/{admin_id}', { params: { path: { admin_id } }, body })),
    /** 独立设置受控身份类型。 */
    setIdentity: async (admin_id: string, body: Body<paths['/api/v1/admin/accounts/{admin_id}/identity']['put']>) =>
      unwrap(
        await this.client.PUT('/api/v1/admin/accounts/{admin_id}/identity', { params: { path: { admin_id } }, body }),
      ),
    /** 重置他人密码，撤销旧会话。 */
    resetPassword: async (
      admin_id: string,
      body: Body<paths['/api/v1/admin/accounts/{admin_id}/reset-password']['post']>,
    ) =>
      unwrap(
        await this.client.POST('/api/v1/admin/accounts/{admin_id}/reset-password', {
          params: { path: { admin_id } },
          body,
        }),
      ),
    /** 软删除后台用户，保留历史与登录账号。 */
    delete: async (admin_id: string, body: Body<paths['/api/v1/admin/accounts/{admin_id}']['delete']>) =>
      unwrap(await this.client.DELETE('/api/v1/admin/accounts/{admin_id}', { params: { path: { admin_id } }, body })),
  };

  readonly adminGroups = {
    /** 分页查询自定义用户组。 */
    list: async (query: Query<paths['/api/v1/admin/groups']['get']> = {}, signal?: AbortSignal) =>
      unwrap(await this.client.GET('/api/v1/admin/groups', { params: { query }, signal })),
    /** 新建无业务授权的用户组。 */
    create: async (body: Body<paths['/api/v1/admin/groups']['post']>) =>
      unwrap(await this.client.POST('/api/v1/admin/groups', { body })),
    /** 修改组资料或启用状态。 */
    update: async (group_id: string, body: Body<paths['/api/v1/admin/groups/{group_id}']['patch']>) =>
      unwrap(await this.client.PATCH('/api/v1/admin/groups/{group_id}', { params: { path: { group_id } }, body })),
    /** 删除无成员的用户组。 */
    delete: async (group_id: string, body: Body<paths['/api/v1/admin/groups/{group_id}']['delete']>) =>
      unwrap(await this.client.DELETE('/api/v1/admin/groups/{group_id}', { params: { path: { group_id } }, body })),
    /** 保存组业务权限与页面访问配置。 */
    setPermissions: async (group_id: string, body: Body<paths['/api/v1/admin/groups/{group_id}/permissions']['put']>) =>
      unwrap(
        await this.client.PUT('/api/v1/admin/groups/{group_id}/permissions', { params: { path: { group_id } }, body }),
      ),
    /** 查看组内后台用户。 */
    members: async (
      group_id: string,
      query: Query<paths['/api/v1/admin/groups/{group_id}/members']['get']> = {},
      signal?: AbortSignal,
    ) =>
      unwrap(
        await this.client.GET('/api/v1/admin/groups/{group_id}/members', {
          params: { path: { group_id }, query },
          signal,
        }),
      ),
    /** 查询其他组中可转入的后台用户。 */
    candidates: async (
      group_id: string,
      query: Query<paths['/api/v1/admin/groups/{group_id}/candidates']['get']> = {},
      signal?: AbortSignal,
    ) =>
      unwrap(
        await this.client.GET('/api/v1/admin/groups/{group_id}/candidates', {
          params: { path: { group_id }, query },
          signal,
        }),
      ),
    /** 校验全部成员当前版本与归属后，原子转入目标组。 */
    transferMembers: async (group_id: string, body: Body<paths['/api/v1/admin/groups/{group_id}/members']['post']>) =>
      unwrap(
        await this.client.POST('/api/v1/admin/groups/{group_id}/members', { params: { path: { group_id } }, body }),
      ),
  };

  readonly adminUsers = {
    /** 换绑手机号并撤销用户旧登录，当前号码用于检查并发修改。 */
    changePhone: async (user_id: string, body: Body<paths['/api/v1/admin/users/{user_id}/phone']['put']>) =>
      unwrap(await this.client.PUT('/api/v1/admin/users/{user_id}/phone', { params: { path: { user_id } }, body })),
    /** 重置应用用户密码，不读取或回显已有密码。 */
    resetPassword: async (user_id: string, body: Body<paths['/api/v1/admin/users/{user_id}/reset-password']['post']>) =>
      unwrap(
        await this.client.POST('/api/v1/admin/users/{user_id}/reset-password', { params: { path: { user_id } }, body }),
      ),
    /** 以头像版本校验替换图片，并保留管理操作原因。 */
    uploadAvatar: async (user_id: string, body: Body<paths['/api/v1/admin/users/{user_id}/avatar']['put']>) =>
      unwrap(await this.client.PUT('/api/v1/admin/users/{user_id}/avatar', { params: { path: { user_id } }, body })),
    /** 移除头像时验证当前版本，避免删除他人刚更新的图片。 */
    deleteAvatar: async (user_id: string, body: Body<paths['/api/v1/admin/users/{user_id}/avatar']['delete']>) =>
      unwrap(await this.client.DELETE('/api/v1/admin/users/{user_id}/avatar', { params: { path: { user_id } }, body })),
    /** 按手机号、芝麻号和启用状态查询应用用户。 */
    list: async (query: Query<paths['/api/v1/admin/users']['get']> = {}, signal?: AbortSignal) =>
      unwrap(await this.client.GET('/api/v1/admin/users', { params: { query }, signal })),
    /** 获取服务端白名单内的用户资料。 */
    detail: async (user_id: string, signal?: AbortSignal) =>
      unwrap(await this.client.GET('/api/v1/admin/users/{user_id}', { params: { path: { user_id } }, signal })),
    /** 分页查询用户实际设备记录。 */
    devices: async (
      user_id: string,
      query: Query<paths['/api/v1/admin/users/{user_id}/devices']['get']> = {},
      signal?: AbortSignal,
    ) =>
      unwrap(
        await this.client.GET('/api/v1/admin/users/{user_id}/devices', {
          params: { path: { user_id }, query },
          signal,
        }),
      ),
    /** 根据确认结果启用或禁用应用用户。 */
    setEnabled: async (
      user_id: string,
      enabled: boolean,
      body: Body<paths['/api/v1/admin/users/{user_id}/disable']['patch']>,
    ) =>
      enabled
        ? unwrap(
            await this.client.PATCH('/api/v1/admin/users/{user_id}/enable', { params: { path: { user_id } }, body }),
          )
        : unwrap(
            await this.client.PATCH('/api/v1/admin/users/{user_id}/disable', { params: { path: { user_id } }, body }),
          ),
    /** 撤销指定设备登录，同时记录操作原因。 */
    revokeDevice: async (
      user_id: string,
      device_id: string,
      body: Body<paths['/api/v1/admin/users/{user_id}/devices/{device_id}/revoke']['post']>,
    ) =>
      unwrap(
        await this.client.POST('/api/v1/admin/users/{user_id}/devices/{device_id}/revoke', {
          params: { path: { user_id, device_id } },
          body,
        }),
      ),
  };

  readonly adminFitnessTaxonomies = {
    /** 查询分类与当前官方动作、模板引用数量。 */
    list: async (kind: 'body_part' | 'equipment', signal?: AbortSignal) =>
      unwrap(await this.client.GET('/api/v1/admin/fitness/taxonomies/{kind}', { params: { path: { kind } }, signal })),
    /** 新建分类时只提交名称和排序，稳定标识由服务端生成。 */
    create: async (
      kind: 'body_part' | 'equipment',
      body: Body<paths['/api/v1/admin/fitness/taxonomies/{kind}']['post']>,
    ) =>
      unwrap(await this.client.POST('/api/v1/admin/fitness/taxonomies/{kind}', { params: { path: { kind } }, body })),
    /** 按版本更新分类名称和排序，防止覆盖他人修改。 */
    update: async (
      kind: 'body_part' | 'equipment',
      taxon_id: string,
      body: Body<paths['/api/v1/admin/fitness/taxonomies/{kind}/{taxon_id}']['patch']>,
    ) =>
      unwrap(
        await this.client.PATCH('/api/v1/admin/fitness/taxonomies/{kind}/{taxon_id}', {
          params: { path: { kind, taxon_id } },
          body,
        }),
      ),
    /** 删除有引用的分类时携带替代项，由服务端原子迁移动作与模板。 */
    delete: async (
      kind: 'body_part' | 'equipment',
      taxon_id: string,
      body: Body<paths['/api/v1/admin/fitness/taxonomies/{kind}/{taxon_id}']['delete']>,
    ) =>
      unwrap(
        await this.client.DELETE('/api/v1/admin/fitness/taxonomies/{kind}/{taxon_id}', {
          params: { path: { kind, taxon_id } },
          body,
        }),
      ),
  };

  readonly adminAudit = {
    /** 读取服务端维护的日志操作类型，避免从当前分页推断完整筛选目录。 */
    actions: async (signal?: AbortSignal) => unwrap(await this.client.GET('/api/v1/admin/audit-actions', { signal })),
    /** 按真实总数分页查询业务操作日志。 */
    list: async (query: Query<paths['/api/v1/admin/audit-logs']['get']> = {}, signal?: AbortSignal) =>
      unwrap(await this.client.GET('/api/v1/admin/audit-logs', { params: { query }, signal })),
  };

  readonly adminCatalog = {
    /** 读取服务端维护的身份类型目录。 */
    identities: async (signal?: AbortSignal) =>
      unwrap(await this.client.GET('/api/v1/admin/identity-types', { signal })),
    /** 读取页面、操作及其依赖，供权限树使用。 */
    permissions: async (signal?: AbortSignal) =>
      unwrap(await this.client.GET('/api/v1/admin/permission-catalog', { signal })),
  };

  readonly adminAnalytics = {
    /** 查询统一时间范围的指标和趋势，范围活跃人数由服务端整体去重。 */
    report: async (query: Query<paths['/api/v1/admin/analytics']['get']>, signal?: AbortSignal) =>
      unwrap(await this.client.GET('/api/v1/admin/analytics', { params: { query }, signal })),
    /** 查询事件趋势、页面访问和操作排行。 */
    details: async (query: Query<paths['/api/v1/admin/analytics/details']['get']>, signal?: AbortSignal) =>
      unwrap(await this.client.GET('/api/v1/admin/analytics/details', { params: { query }, signal })),
    /** 读取固定代码埋点清单，目录与统计日期范围无关。 */
    catalog: async (signal?: AbortSignal) =>
      unwrap(await this.client.GET('/api/v1/admin/analytics/catalog', { signal })),
    /** 按所选步骤、关联口径和转化窗口查询只读漏斗。 */
    funnel: async (body: Body<paths['/api/v1/admin/analytics/funnel']['post']>, signal?: AbortSignal) =>
      unwrap(await this.client.POST('/api/v1/admin/analytics/funnel', { body, signal })),
  };

  readonly adminFitnessExercises = {
    /** 分页查询动作资料和状态。 */
    list: async (query: Query<paths['/api/v1/admin/fitness/exercises']['get']> = {}, signal?: AbortSignal) =>
      unwrap(await this.client.GET('/api/v1/admin/fitness/exercises', { params: { query }, signal })),
    /** 新建动作并立即生效，标识由服务端生成。 */
    create: async (body: Body<paths['/api/v1/admin/fitness/exercises']['post']>) =>
      unwrap(await this.client.POST('/api/v1/admin/fitness/exercises', { body })),
    /** 按当前版本保存动作资料并立即生效。 */
    update: async (content_id: string, body: Body<paths['/api/v1/admin/fitness/exercises/{content_id}']['patch']>) =>
      unwrap(
        await this.client.PATCH('/api/v1/admin/fitness/exercises/{content_id}', {
          params: { path: { content_id } },
          body,
        }),
      ),
  };

  readonly adminFitnessTemplates = {
    /** 分页查询官方训练模板。 */
    list: async (query: Query<paths['/api/v1/admin/fitness/templates']['get']> = {}, signal?: AbortSignal) =>
      unwrap(await this.client.GET('/api/v1/admin/fitness/templates', { params: { query }, signal })),
    /** 创建模板并立即生效。 */
    create: async (body: Body<paths['/api/v1/admin/fitness/templates']['post']>) =>
      unwrap(await this.client.POST('/api/v1/admin/fitness/templates', { body })),
    /** 保存模板资料与动作编排并立即生效。 */
    update: async (content_id: string, body: Body<paths['/api/v1/admin/fitness/templates/{content_id}']['patch']>) =>
      unwrap(
        await this.client.PATCH('/api/v1/admin/fitness/templates/{content_id}', {
          params: { path: { content_id } },
          body,
        }),
      ),
  };

  readonly adminFitnessPlans = {
    /** 分页查询官方训练计划。 */
    list: async (query: Query<paths['/api/v1/admin/fitness/plans']['get']> = {}, signal?: AbortSignal) =>
      unwrap(await this.client.GET('/api/v1/admin/fitness/plans', { params: { query }, signal })),
    /** 创建周期计划并立即生效。 */
    create: async (body: Body<paths['/api/v1/admin/fitness/plans']['post']>) =>
      unwrap(await this.client.POST('/api/v1/admin/fitness/plans', { body })),
    /** 保存计划资料与每日模板编排。 */
    update: async (content_id: string, body: Body<paths['/api/v1/admin/fitness/plans/{content_id}']['patch']>) =>
      unwrap(
        await this.client.PATCH('/api/v1/admin/fitness/plans/{content_id}', { params: { path: { content_id } }, body }),
      ),
  };

  readonly adminFitnessMedia = {
    /** 上传受控 GIF 并取得后台预览地址，保存动作后对应用生效。 */
    upload: async (body: Body<paths['/api/v1/admin/fitness/media']['post']>) =>
      unwrap(await this.client.POST('/api/v1/admin/fitness/media', { body })),
  };

  readonly adminFitnessReferences = {
    /** 读取动作与模板的名称目录，表单不显示技术标识。 */
    list: async (signal?: AbortSignal) => unwrap(await this.client.GET('/api/v1/admin/fitness/references', { signal })),
  };
}
