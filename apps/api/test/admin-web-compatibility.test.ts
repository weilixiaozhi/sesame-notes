import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { adminMigrationTestDatabaseUrl } from './admin-migration-test-database.js';

const sharedWebPaths = [
  '/api/v1/auth/browser/register',
  '/api/v1/auth/browser/login',
  '/api/v1/auth/browser/refresh',
  '/api/v1/auth/browser/logout',
  '/api/v1/exchange-rate-overrides',
  '/api/v1/ledgers/{ledger_id}/action-preview',
  '/api/v1/ledgers/{ledger_id}/clear',
  '/api/v1/ledgers/{ledger_id}/change-currency',
  '/api/v1/category-conflicts',
  '/api/v1/category-conflicts/{conflict_id}/resolve',
  '/api/v1/ledgers/{ledger_id}/categories/add-batch',
  '/api/v1/ledgers/{ledger_id}/categories/reorder',
  '/api/v1/ledgers/{ledger_id}/categories/removal-preview',
  '/api/v1/ledgers/{ledger_id}/categories/remove',
  '/api/v1/ledgers/{ledger_id}/transaction-stats',
  '/api/v1/ledgers/{ledger_id}/aa-stats',
  '/api/v1/ledgers/{ledger_id}/participants',
  '/api/v1/memo-books/{memo_book_id}/entries',
  '/api/v1/day-books/{day_book_id}/events',
  '/api/v1/memo-books/{memo_book_id}/calendar-counts',
  '/api/v1/fitness-spaces/{fitness_space_id}/templates',
  '/api/v1/fitness-spaces/{fitness_space_id}/plans',
  '/api/v1/fitness-spaces/{fitness_space_id}/workouts',
  '/api/v1/fitness-spaces/{fitness_space_id}/preferences',
  '/api/v1/fitness-spaces/{fitness_space_id}/plans/{plan_id}/command',
  '/api/v1/fitness-spaces/{fitness_space_id}/statistics',
  '/api/v1/fitness-spaces/{fitness_space_id}/calendar',
  '/api/v1/fitness-spaces/{fitness_space_id}/workouts/{workout_id}',
  '/api/v1/fitness-spaces/{fitness_space_id}/export',
  '/api/v1/fitness-spaces/{fitness_space_id}/import',
];

describe('共享API同时保留Web业务与独立Admin', () => {
  it('公开契约保留30个Web扩展路径，认证方案分别声明且后台启停要求正文', async () => {
    const app = buildApp({
      logger: false,
      config: loadConfig({
        DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
        JWT_SECRET: 'web-admin-compatibility-at-least-32-byte-secret',
        STORAGE_PATH: 'Temp/web-admin-contract',
      }),
      prisma: { $disconnect: vi.fn().mockResolvedValue(undefined) } as unknown as PrismaClient,
    });
    try {
      await app.ready();
      const document = app.swagger() as {
        paths: Record<string, Record<string, { security?: object[]; requestBody?: { required?: boolean } }>>;
      };
      for (const path of sharedWebPaths) expect(document.paths[path], path).toBeDefined();
      expect(document.paths['/api/v1/auth/browser/login']!.post!.security).toEqual([]);
      expect(document.paths['/api/v1/auth/login']!.post!.security).toEqual([]);
      expect(document.paths['/api/v1/admin/auth/login']!.post!.security).toEqual([]);
      expect(document.paths['/api/v1/admin/groups']!.get!.security).toEqual([{ adminSessionAuth: [] }]);
      expect(document.paths['/api/v1/fitness-spaces/{fitness_space_id}/plans']!.get!.security).toEqual([
        { bearerAuth: [] },
      ]);
      for (const action of ['enable', 'disable'])
        expect(document.paths[`/api/v1/admin/users/{user_id}/${action}`]!.patch!.requestBody!.required).toBe(true);
    } catch (error) {
      throw new Error('共享API能力与认证契约验证失败', { cause: error });
    } finally {
      await app.close();
    }
  });

  it('Admin迁移验收不能隐式回退共享库或用确认标识绕过共享端口', () => {
    const isolated = {
      SESAME_ENV: 'test',
      NODE_ENV: 'test',
      E2E_DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:55439/sesame_test_admin_clone',
      E2E_ADMIN_MIGRATION_SUITE: 'isolated-clone-only-v1',
    };
    expect(adminMigrationTestDatabaseUrl(isolated)).toBe(isolated.E2E_DATABASE_URL);
    expect(() => adminMigrationTestDatabaseUrl({ ...isolated, E2E_ADMIN_MIGRATION_SUITE: undefined })).toThrow(
      '独立副本',
    );
    expect(() =>
      adminMigrationTestDatabaseUrl({
        ...isolated,
        E2E_DATABASE_URL: isolated.E2E_DATABASE_URL.replace('55439', '55432'),
      }),
    ).toThrow('独立副本');
    expect(() =>
      adminMigrationTestDatabaseUrl({
        ...isolated,
        E2E_DATABASE_URL: 'postgresql://unused:unused@localhost:55432/sesame_notes_test',
      }),
    ).toThrow('独立副本');
  });
});
