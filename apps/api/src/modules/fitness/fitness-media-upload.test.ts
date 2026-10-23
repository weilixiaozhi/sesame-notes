import cookie from '@fastify/cookie';
import type { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../../shared/api-config.js';
import { registerErrorHandler } from '../../shared/errors.js';
import { createOwnedFixture, removeOwnedFixture } from '../../../test/owned-fixture-directory.js';
import { registerOfficialFitnessMediaRoutes } from './official-fitness-media.js';
import { fitnessMediaFile } from './fitness-media-storage.js';

const ORIGIN = 'https://admin.example.test';
const HEADERS = {
  cookie: `__Secure-sesame_admin_session=${'a'.repeat(64)}`,
  origin: ORIGIN,
  'x-admin-request': '1',
};

/** 真实管理员守卫读取内存会话，媒体与审计在模拟事务失败时共同回滚。 */
function repository() {
  let saved: Record<string, unknown> | null = null;
  const session = {
    id: 'session',
    tokenHash: 'hash',
    revokedAt: null,
    lastSeenAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    admin: {
      id: '22222222-2222-4222-8222-222222222222',
      username: 'operator',
      email: null,
      phone: null,
      displayName: '管理员',
      identityType: 'standard_user',
      isEnabled: true,
      deletedAt: null,
      groupId: 'group',
      group: {
        id: 'group',
        name: '运营',
        version: 1,
        isEnabled: true,
        deletedAt: null,
        permissions: ['fitness:read', 'fitness:write'],
        pageIds: [],
      },
    },
  };
  const db = {
    session,
    officialFitnessMedia: {
      findUnique: vi.fn(async () => saved),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
        saved ??= create;
        return saved;
      }),
    },
    officialFitnessContent: { findFirst: vi.fn(async () => null) },
    adminSession: { findUnique: vi.fn(async () => session), update: vi.fn(async () => ({})) },
    adminAccount: { findUnique: vi.fn(async () => ({ username: 'operator' })) },
    auditLog: { create: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => [{ locked: true }]),
    $transaction: vi.fn(),
  };
  /** 普通权限事务也走此处，只有媒体元数据变更需要恢复前值。 */
  db.$transaction.mockImplementation(async (operation: (tx: typeof db) => Promise<unknown>) => {
    const previous = saved;
    try {
      return await operation(db);
    } catch (error) {
      saved = previous;
      throw error;
    }
  });
  return db;
}

describe('官方媒体真实上传路由', () => {
  it.each(['success', 'audit-failure', 'revoked-before-publication'] as const)(
    '%s 在独立后台授权与文件发布之间保持一致结果',
    async (mode) => {
      const root = await createOwnedFixture('api-fix-media-route');
      const app = Fastify({ logger: false });
      try {
        const db = repository();
        if (mode === 'audit-failure') db.auditLog.create.mockRejectedValue(new Error('audit unavailable'));
        if (mode === 'revoked-before-publication') {
          db.adminSession.findUnique.mockResolvedValueOnce(db.session).mockResolvedValue({
            ...db.session,
            admin: { ...db.session.admin, isEnabled: false },
          });
        }
        await app.register(cookie);
        registerErrorHandler(app);
        registerOfficialFitnessMediaRoutes(
          app,
          db as unknown as PrismaClient,
          {
            adminOrigins: [ORIGIN],
            storagePath: root,
          } as ApiConfig,
        );
        const bytes = await readFile(fitnessMediaFile(root, 'builtin-0025'));
        const id = createHash('sha256').update(bytes).digest('hex');
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/fitness/media',
          headers: HEADERS,
          payload: { filename: 'exercise.gif', data_base64: bytes.toString('base64') },
        });
        if (mode === 'success') {
          expect(response.statusCode, response.body).toBe(201);
          expect(response.json().id).toBe(id);
          expect(await readFile(fitnessMediaFile(root, id))).toEqual(bytes);
          expect(db.auditLog.create).toHaveBeenCalledOnce();
          expect(db.$executeRaw).toHaveBeenCalledOnce();
          expect(await readdir(resolve(root, 'fitness-media'))).toEqual([`${id}.gif`]);
        } else {
          expect(response.statusCode, response.body).toBe(mode === 'audit-failure' ? 500 : 401);
          expect(response.body).not.toContain('audit unavailable');
          expect(db.officialFitnessMedia.upsert).toHaveBeenCalledTimes(mode === 'audit-failure' ? 1 : 0);
          expect(await readdir(resolve(root, 'fitness-media'))).toEqual([]);
          await expect(stat(fitnessMediaFile(root, id))).rejects.toMatchObject({ code: 'ENOENT' });
        }
      } catch (cause) {
        throw new Error('官方媒体上传路由回归失败', { cause });
      } finally {
        await app.close();
        await removeOwnedFixture(root);
      }
    },
  );
});
