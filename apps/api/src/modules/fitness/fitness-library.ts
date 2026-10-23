import type { PrismaClient } from '@prisma/client';
import { Value } from '@sinclair/typebox/value';
import type { FastifyInstance } from 'fastify';

import exerciseCatalog from './fitness-catalog.json' with { type: 'json' };
import librarySource from './fitness-library.json' with { type: 'json' };
import { FitnessLibrarySchema, type FitnessLibrary } from './fitness-library-schemas.js';
import { contentEtag, readOfficialContent } from './official-fitness.js';

/** 校验官方内容的封闭结构、稳定身份、计划引用和动作目录引用。 */
export function validateFitnessLibrary(value: unknown): asserts value is FitnessLibrary {
  try {
    if (!Value.Check(FitnessLibrarySchema, value)) throw new Error('官方训练内容结构无效');
    const templateIds = new Set<string>();
    for (const template of value.templates) {
      if (templateIds.has(template.id)) throw new Error(`官方训练模板标识重复：${template.id}`);
      templateIds.add(template.id);
      for (const exercise of template.exercises) {
        if (!exerciseCatalog.exercises.some((entry) => entry.id === exercise.exercise_id))
          throw new Error(`官方训练模板 ${template.id} 引用了未知动作：${exercise.exercise_id}`);
        if ((exercise.weight_mode === 'body_weight') !== (exercise.weight_kg === null))
          throw new Error(`官方训练模板 ${template.id} 的重量口径无效`);
      }
    }
    const planIds = new Set<string>();
    for (const plan of value.plans) {
      if (planIds.has(plan.id)) throw new Error(`官方训练计划标识重复：${plan.id}`);
      planIds.add(plan.id);
      if (
        plan.days.length !== plan.cycle_days ||
        new Set(plan.days.map((day) => day.day_index)).size !== plan.cycle_days ||
        plan.days.some((day) => day.day_index >= plan.cycle_days) ||
        !plan.days.some((day) => day.template_id !== null)
      )
        throw new Error(`官方训练计划 ${plan.id} 的周期安排无效`);
      for (const day of plan.days) {
        if (day.template_id !== null && !templateIds.has(day.template_id))
          throw new Error(`官方训练计划 ${plan.id} 引用了未知模板：${day.template_id}`);
      }
    }
  } catch (error) {
    throw new Error('官方训练内容库校验失败', { cause: error });
  }
}

validateFitnessLibrary(librarySource);
export const fitnessLibrary: FitnessLibrary = librarySource;

/** 注册全局只读训练内容库；ETag 命中时不重复发送完整正文。 */
export function registerFitnessLibraryRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  app.get(
    '/api/v1/fitness/library',
    {
      schema: {
        operationId: 'getFitnessLibrary',
        tags: ['fitness'],
        headers: {
          type: 'object',
          properties: { 'if-none-match': { type: 'string', maxLength: 128 } },
        },
        response: { 200: FitnessLibrarySchema, 304: { type: 'null' } },
      },
    },
    async (request, reply) => {
      try {
        const { version, rows } = await readOfficialContent(prisma);
        const library: FitnessLibrary = {
          schema_version: 1,
          content_version: version,
          templates: rows
            .filter((row) => row.kind === 'template' && row.isEnabled)
            .map((row) => row.content as unknown as FitnessLibrary['templates'][number]),
          plans: rows
            .filter((row) => row.kind === 'plan' && row.isEnabled)
            .map((row) => row.content as unknown as FitnessLibrary['plans'][number]),
        };
        const etag = contentEtag(library);
        reply.header('etag', etag);
        reply.header('cache-control', 'public, max-age=60, stale-if-error=86400');
        if (request.headers['if-none-match'] === etag) return await reply.status(304).send();
        return library;
      } catch (error) {
        request.log.error({ err: error, request_id: request.id }, '读取官方训练内容库失败');
        throw new Error('官方训练内容库暂时不可用', { cause: error });
      }
    },
  );
}
