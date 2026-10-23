import type { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../../shared/api-config.js';
import { registerErrorHandler } from '../../shared/errors.js';
import { registerProfileRoutes } from './profile-routes.js';

vi.mock('../auth/index.js', () => ({
  authenticate: () => async () => {},
  requireScopes: () => async () => {},
  requireAuth: () => ({ userId: '11111111-1111-4111-8111-111111111111' }),
}));

/** 真实路由负责校验和规范化，内存资料仓储只记录实际写入。 */
function application() {
  try {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    const profile = {
      displayName: '测试用户',
      avatarFileId: null,
      avatarVersion: 0,
      gender: 'UNSPECIFIED',
      themePrimaryColor: '#123456' as string | null,
      appearance: null,
      aiConfig: null,
      primaryCurrency: null,
    };
    const db = {
      userProfile: {
        upsert: vi.fn(async ({ update }: { update: { themePrimaryColor?: string | null } }) => {
          Object.assign(profile, update);
          return profile;
        }),
      },
      user: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: '11111111-1111-4111-8111-111111111111',
          sesameNumber: '123456789',
          phoneE164: '+8613800000000',
          profile,
        })),
      },
    };
    registerProfileRoutes(app, db as unknown as PrismaClient, {} as ApiConfig);
    return { app, db };
  } catch (cause) {
    throw new Error('主题色路由测试准备失败', { cause });
  }
}

describe('本人主题色输入边界', () => {
  it.each(['#FFFFFFsuffix', '#12FFAB\n', '#12FFAB\r', '#12FFAB ', '#12345', '#12345G', 'red'])(
    '非法颜色 %j 在写入前返回统一 400',
    async (color) => {
      const { app, db } = application();
      try {
        const response = await app.inject({
          method: 'PATCH',
          url: '/api/v1/profile/me',
          payload: { theme_primary_color: color },
        });
        expect(response.statusCode, response.body).toBe(400);
        expect(response.json().code).toBe('VALIDATION_ERROR');
        expect(db.userProfile.upsert).not.toHaveBeenCalled();
      } catch (cause) {
        throw new Error('主题色非法输入回归失败', { cause });
      } finally {
        await app.close();
      }
    },
  );

  it('合法大小写规范化，缺省保持现值，显式 null 清空', async () => {
    const { app, db } = application();
    try {
      for (const [body, expected] of [
        [{ theme_primary_color: '#aBcDeF' }, '#ABCDEF'],
        [{}, '#ABCDEF'],
        [{ theme_primary_color: null }, null],
      ] as const) {
        const response = await app.inject({ method: 'PATCH', url: '/api/v1/profile/me', payload: body });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().theme_primary_color).toBe(expected);
      }
      expect(db.userProfile.upsert.mock.calls[1]![0].update).not.toHaveProperty('themePrimaryColor');
      expect(db.userProfile.upsert.mock.calls[2]![0].update).toHaveProperty('themePrimaryColor', null);
    } catch (cause) {
      throw new Error('主题色清空与缺省语义回归失败', { cause });
    } finally {
      await app.close();
    }
  });
});
