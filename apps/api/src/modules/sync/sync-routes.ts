import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import type { TSchema } from '@sinclair/typebox';
import type { ApiConfig } from '../../shared/api-config.js';
import { DayBookSchema, DayDateSchema, DayEventSchema } from '../days/index.js';
import { MemoBookSchema, MemoEntrySchema } from '../memos/index.js';
import { registerOnlineReadRoutes } from './online-read-routes.js';
import { registerPushRoutes } from './push-routes.js';
import { registerFitnessSpacesRoutes } from './fitness-spaces-routes.js';
import { registerFitnessSpacesFullRoutes } from './fitness-spaces-full-routes.js';
import { registerPullRoutes } from './pull-routes.js';
import { registerFullRoutes } from './full-routes.js';
import { registerMemoBooksRoutes } from './memo-books-routes.js';
import { registerMemoBooksFullRoutes } from './memo-books-full-routes.js';
import { registerDayBooksRoutes } from './day-books-routes.js';
import { registerDayBooksFullRoutes } from './day-books-full-routes.js';
import { registerAccountingFullRoutes } from './accounting-full-routes.js';
/** 按协议顺序注册同步入口，schema 先于任何引用它的路由。 */
export function registerSyncRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  // 显式标注 schema 元素类型，避免 TypeScript 对不同实体的联合结构进行过深推导。
  const sharedSchemas: TSchema[] = [
    // 展开加 $id 后 TS 会尝试实例化整个 schema 联合类型，显式断言避免推导过深
    { ...DayDateSchema, $id: 'DayOriginalDate' } as TSchema,
    DayBookSchema,
    DayEventSchema,
    MemoBookSchema,
    MemoEntrySchema,
  ];
  for (const schema of sharedSchemas) app.addSchema(schema);
  registerOnlineReadRoutes(app, prisma, config);
  registerPushRoutes(app, prisma, config);
  registerFitnessSpacesRoutes(app, prisma, config);
  registerFitnessSpacesFullRoutes(app, prisma, config);
  registerPullRoutes(app, prisma, config);
  registerFullRoutes(app, prisma, config);
  registerMemoBooksRoutes(app, prisma, config);
  registerMemoBooksFullRoutes(app, prisma, config);
  registerDayBooksRoutes(app, prisma, config);
  registerDayBooksFullRoutes(app, prisma, config);
  registerAccountingFullRoutes(app, prisma, config);
}
