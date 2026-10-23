import { normalizeName } from '../../shared/text-validation.js';
import { NameSchema, CurrencySchema, UuidSchema } from '../../shared/contracts/scalars.js';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

import type { ApiConfig } from '../../shared/api-config.js';
import { authenticate, requireAuth, requireScopes } from '../auth/index.js';
import { ApiError } from '../../shared/errors.js';

import { execute } from '../../shared/execute.js';

const ProfileSchema = Type.Object({
  user_id: UuidSchema,
  sesame_number: Type.Union([Type.String(), Type.Null()]),
  display_name: Type.Union([Type.String(), Type.Null()]),
  avatar_url: Type.Union([Type.String(), Type.Null()]),
  avatar_version: Type.Integer({ minimum: 0 }),
  // 完整手机号仅本人可见
  phone: Type.String(),
  gender: Type.Union([Type.Literal('UNSPECIFIED'), Type.Literal('MALE'), Type.Literal('FEMALE')]),
  theme_primary_color: Type.Union([Type.String(), Type.Null()]),
  appearance: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
  ai_config: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
  primary_currency: Type.Union([CurrencySchema, Type.Null()]),
});

type ProfilePatch = {
  // 昵称恒非空:注册即分配默认昵称,null/空串在运行时统一拒绝。
  display_name?: string | null;
  gender?: 'UNSPECIFIED' | 'MALE' | 'FEMALE';
  theme_primary_color?: string | null;
  appearance?: Record<string, unknown> | null;
  ai_config?: Record<string, unknown> | null;
  primary_currency?: string | null;
};

/** 注册本人资料查询与更新接口。 */
export function registerProfileRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  // 资料路由按资源校验最小 scope：读 profile:read，写 profile:write
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('profile:read', 'profile:write')] };

  app.get(
    '/api/v1/profile/me',
    { ...secured, schema: { tags: ['profile'], response: { 200: ProfileSchema } } },
    async (request) =>
      execute(request, '读取个人资料', async () => {
        const auth = requireAuth(request);
        const user = await prisma.user.findUnique({ where: { id: auth.userId }, include: { profile: true } });
        if (!user) throw new ApiError(404, 'USER_NOT_FOUND', '用户不存在');
        return mapProfile(user);
      }),
  );

  app.patch(
    '/api/v1/profile/me',
    {
      ...secured,
      schema: {
        tags: ['profile'],
        body: Type.Object({
          // 昵称不可置空(账号昵称恒非空):schema 只限定长度,null/空串/
          // 纯空白统一在运行时映射为 DISPLAY_NAME_INVALID,保证错误码稳定。
          display_name: Type.Optional(Type.Union([NameSchema, Type.Null()])),
          gender: Type.Optional(Type.String()),
          theme_primary_color: Type.Optional(Type.Union([Type.String({ pattern: '^#[0-9A-Fa-f]{6}' }), Type.Null()])),
          appearance: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
          ai_config: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
          primary_currency: Type.Optional(Type.Union([CurrencySchema, Type.Null()])),
        }),
        response: { 200: ProfileSchema },
      },
    },
    async (request) =>
      execute(request, '更新个人资料', async () => {
        const auth = requireAuth(request);
        const body = request.body as ProfilePatch;
        // Fastify 默认 Ajv 会静默移除未知字段，因此运行时显式拒绝：
        // 手机号与芝麻号不可修改，契约不接收这些字段
        const unknownKeys = Object.keys(body).filter(
          (key) =>
            !['display_name', 'gender', 'theme_primary_color', 'appearance', 'ai_config', 'primary_currency'].includes(
              key,
            ),
        );
        if (unknownKeys.length > 0) {
          throw new ApiError(400, 'VALIDATION_ERROR', '请求参数不符合接口要求');
        }
        // 昵称按共用名称规则校验可见文字、Unicode 编码和长度；性别只接受三种枚举值。
        if (body.display_name !== undefined) {
          try {
            normalizeName(body.display_name);
          } catch {
            throw new ApiError(400, 'DISPLAY_NAME_INVALID', '昵称格式不正确');
          }
        }
        if (body.gender !== undefined && !['UNSPECIFIED', 'MALE', 'FEMALE'].includes(body.gender)) {
          throw new ApiError(400, 'GENDER_INVALID', '性别选项无效');
        }
        // 请求 Schema 已验证颜色前缀；精确长度拒绝尾随字符，缺省与 null 分别保留和清空。
        if (body.theme_primary_color != null && body.theme_primary_color.length !== 7) {
          throw new ApiError(400, 'VALIDATION_ERROR', '主题色须为 #RRGGBB 格式的七字符颜色');
        }
        await prisma.userProfile.upsert({
          where: { userId: auth.userId },
          create: { userId: auth.userId, ...profilePatchData(body) },
          update: profilePatchData(body),
        });
        const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, include: { profile: true } });
        return mapProfile(user);
      }),
  );
}

/** 本人资料包含完整手机号；共享成员资料由成员映射另行构造。 */
function mapProfile(user: {
  id: string;
  phoneE164: string;
  sesameNumber: string;
  profile: {
    displayName: string | null;
    avatarFileId: string | null;
    avatarVersion: number;
    gender: string;
    themePrimaryColor: string | null;
    appearance: Prisma.JsonValue;
    aiConfig: Prisma.JsonValue;
    primaryCurrency: string | null;
  } | null;
}) {
  return {
    user_id: user.id,
    sesame_number: user.sesameNumber,
    display_name: user.profile?.displayName ?? null,
    avatar_url: user.profile?.avatarFileId ? `/api/v1/profile/avatar/${user.id}?v=${user.profile.avatarVersion}` : null,
    avatar_version: user.profile?.avatarVersion ?? 0,
    phone: user.phoneE164,
    gender: user.profile?.gender ?? 'UNSPECIFIED',
    theme_primary_color: user.profile?.themePrimaryColor ?? null,
    appearance: user.profile?.appearance ?? null,
    ai_config: user.profile?.aiConfig ?? null,
    primary_currency: user.profile?.primaryCurrency ?? null,
  };
}

/** 将资料请求映射为 Prisma 字段，并区分“未传”和显式 null。 */
function profilePatchData(body: ProfilePatch) {
  return {
    ...(body.display_name === undefined || body.display_name === null
      ? {}
      : { displayName: normalizeName(body.display_name) }),
    ...(body.gender === undefined ? {} : { gender: body.gender }),
    ...(body.theme_primary_color === undefined
      ? {}
      : { themePrimaryColor: body.theme_primary_color?.toUpperCase() ?? null }),
    ...(body.appearance === undefined
      ? {}
      : { appearance: body.appearance === null ? Prisma.JsonNull : (body.appearance as Prisma.InputJsonObject) }),
    ...(body.ai_config === undefined
      ? {}
      : { aiConfig: body.ai_config === null ? Prisma.JsonNull : (body.ai_config as Prisma.InputJsonObject) }),
    ...(body.primary_currency === undefined ? {} : { primaryCurrency: body.primary_currency }),
  };
}
