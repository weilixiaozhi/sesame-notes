import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadTestApiConfig } from './test-api-config.js';
import { fitnessLibrary, validateFitnessLibrary } from '../src/modules/fitness/testing.js';

const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe('官方训练内容库', () => {
  it('仅接受当前 v1 结构且拒绝客户端版本协商字段', () => {
    expect(() => validateFitnessLibrary({ ...fitnessLibrary, schema_version: 2 })).toThrow();
    expect(() => validateFitnessLibrary({ ...fitnessLibrary, schema_version: 0 })).toThrow();
    expect(() => validateFitnessLibrary({ ...fitnessLibrary, minimum_client_version: '1.0.0' })).toThrow();
  });
  it('拒绝重复模板和重复计划身份', () => {
    const templates = structuredClone(fitnessLibrary);
    templates.templates.push(structuredClone(templates.templates[0]!));
    expect(() => validateFitnessLibrary(templates)).toThrow();
    const plans = structuredClone(fitnessLibrary);
    plans.plans.push(structuredClone(plans.plans[0]!));
    expect(() => validateFitnessLibrary(plans)).toThrow();
  });
  it('内容结构、动作引用和计划模板引用完整', () => {
    expect(() => validateFitnessLibrary(structuredClone(fitnessLibrary))).not.toThrow();
  });

  it('拒绝不存在的模板引用和动作引用', () => {
    const invalidPlan = structuredClone(fitnessLibrary);
    invalidPlan.plans[0]!.days[0]!.template_id = '99999999-9999-4999-8999-999999999999';
    expect(() => validateFitnessLibrary(invalidPlan)).toThrow('官方训练内容库校验失败');

    const invalidExercise = structuredClone(fitnessLibrary);
    invalidExercise.templates[0]!.exercises[0]!.exercise_id = 'missing';
    expect(() => validateFitnessLibrary(invalidExercise)).toThrow('官方训练内容库校验失败');
  });

  it('公开读取并使用 ETag 避免重复下载', async () => {
    const app = buildApp({ logger: false, config: loadTestApiConfig() });
    apps.push(app);
    await app.ready();

    const first = await app.inject({ method: 'GET', url: '/api/v1/fitness/library' });
    expect(first.statusCode).toBe(200);
    expect(first.headers.etag).toMatch(/^"fitness-[0-9a-f]{24}"$/);
    expect(first.json()).toMatchObject({ schema_version: 1, content_version: expect.any(Number) });
    expect(first.json().content_version).toBeGreaterThanOrEqual(1);
    // 内容未变化时 ETag 必须稳定，否则条件请求永远无法命中。
    const repeated = await app.inject({ method: 'GET', url: '/api/v1/fitness/library' });
    expect(repeated.headers.etag).toBe(first.headers.etag);

    const cached = await app.inject({
      method: 'GET',
      url: '/api/v1/fitness/library',
      headers: { 'if-none-match': first.headers.etag! },
    });
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBe('');
  });
});
