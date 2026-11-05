import { Prisma, type PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { execute } from '../../shared/execute.js';

import { FitnessLibrarySchema, type FitnessLibrary } from './fitness-library-schemas.js';
import { contentEtag } from './official-fitness.js';

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
    async (request, reply) =>
      execute(request, '读取官方训练内容库', async () => {
        // 同一快照内读取启用的训练内容与目录版本，保证响应和缓存标签对应同一次保存。
        const { version, rows } = await prisma.$transaction(
          async (tx) => ({
            version: (
              await tx.officialFitnessState.findUniqueOrThrow({ where: { id: 1 }, select: { contentVersion: true } })
            ).contentVersion,
            rows: await tx.officialFitnessContent.findMany({
              where: { kind: { in: ['template', 'plan'] }, isEnabled: true },
              orderBy: { id: 'asc' },
              select: { kind: true, content: true },
            }),
          }),
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        );
        const library: FitnessLibrary = {
          schema_version: 1,
          content_version: version,
          templates: rows
            .filter((row) => row.kind === 'template')
            .map((row) => row.content as unknown as FitnessLibrary['templates'][number]),
          plans: rows
            .filter((row) => row.kind === 'plan')
            .map((row) => row.content as unknown as FitnessLibrary['plans'][number]),
        };
        const etag = contentEtag(library);
        reply.header('etag', etag);
        reply.header('cache-control', 'public, max-age=60, stale-if-error=86400');
        if (request.headers['if-none-match'] === etag) return await reply.status(304).send();
        return library;
      }),
  );
}
