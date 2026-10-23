import type { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { fitnessExercise, fitnessWorkout } from './fitness-fixtures.js';

/** 模拟存储边界返回违规完成事实，穿过真实认证、统计路由与全局错误边界。 */
it('损坏完成成绩返回可诊断服务端失败，恢复有效事实后返回完整统计', async () => {
  const identity = '11111111-1111-4111-8111-111111111111';
  const config = loadConfig({
    DATABASE_URL: 'postgresql://unused:unused@localhost:1/unused',
    JWT_SECRET: 'fitness-statistics-boundary-secret-at-least-32-bytes',
    STORAGE_PATH: resolve(import.meta.dirname, '../../../Temp/fitness-statistics-boundary'),
  });
  const payload = {
    ...fitnessWorkout(),
    status: 'completed',
    exercises: [fitnessExercise(true)],
    run_segments: [{ started_at: '2026-09-11T01:00:00.000Z', ended_at: '2026-09-11T01:30:00.000Z' }],
  };
  const row = { id: identity, revision: 1, payload };
  const tx = {
    fitnessSpace: { findFirst: vi.fn().mockResolvedValue({ id: identity, syncId: identity }) },
    fitnessEntity: { findMany: vi.fn().mockResolvedValue([row]) },
  };
  const prisma = {
    serverEpoch: { upsert: vi.fn().mockResolvedValue({ authGeneration: identity }) },
    device: { findFirst: vi.fn().mockResolvedValue({ id: identity }) },
    $transaction: vi.fn(async (operation: (transaction: typeof tx) => Promise<unknown>) => operation(tx)),
    $disconnect: vi.fn().mockResolvedValue(undefined),
  };
  const app = buildApp({ logger: false, config, prisma: prisma as unknown as PrismaClient });
  const log = vi.spyOn(app.log, 'error');
  try {
    const token = await new SignJWT({
      device_id: identity,
      auth_generation: identity,
      credential_version: 0,
      scopes: ['sync:read'],
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(identity)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(config.jwtSecret));
    const request = {
      method: 'GET' as const,
      url: `/api/v1/fitness-spaces/${identity}/statistics?start_date=2026-09-11&end_date=2026-09-11&time_zone=UTC`,
      headers: { authorization: `Bearer ${token}` },
    };
    payload.exercises[0]!.sets[0]!.reps = 0;
    const invalid = await app.inject(request);
    expect(invalid.statusCode, invalid.body).toBe(500);
    expect(invalid.json()).toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
    expect(invalid.json()).not.toHaveProperty('completed_sets');
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toMatchObject({
      err: { cause: { message: expect.stringContaining('健身统计数据无效'), cause: expect.any(Error) } },
    });

    payload.exercises[0]!.sets[0]!.reps = 8;
    const valid = await app.inject(request);
    expect(valid.statusCode, valid.body).toBe(200);
    expect(valid.json()).toMatchObject({
      training_days: 1,
      completed_workouts: 1,
      completed_sets: 1,
      total_duration_ms: 1800000,
      volume_kg: '500.0000000008',
    });
  } catch (cause) {
    throw new Error('健身统计 HTTP 边界验收失败', { cause });
  } finally {
    log.mockRestore();
    await app.close();
  }
});
