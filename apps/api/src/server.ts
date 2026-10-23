import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import type { FastifyInstance } from 'fastify';
import { registerShutdown } from './shutdown.js';
import { requireSyncCutover } from './shared/sync-cutover.js';

/** 启动 HTTP 服务并在失败时记录完整错误后退出，避免半初始化进程继续运行。 */
async function startServer(): Promise<void> {
  let app: FastifyInstance | undefined;
  let startupFailed = false;
  try {
    const config = loadConfig();
    const version = await readPackageVersion();
    const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
    app = buildApp({ config, prisma });
    // 只在真实监听入口核对存量库切换；路由装配和契约生成不访问数据库。
    await requireSyncCutover(prisma);
    registerShutdown(app);
    await app.listen({ host: config.host, port: config.port });
    app.log.info({ version }, 'Sesame Notes API 启动成功');
  } catch (error) {
    startupFailed = true;
    if (app) app.log.fatal({ err: error }, 'Sesame Notes API 启动失败');
    else writeStartupLog('fatal', 'Sesame Notes API 启动失败', error);
    process.exitCode = 1;
  } finally {
    if (startupFailed && app) {
      try {
        await app.close();
      } catch (error) {
        app.log.error({ err: error }, '启动失败后的资源清理失败');
      }
    }
  }
}

await startServer();

/** 从当前部署包读取服务发布版本，源码运行和编译产物使用相同的包清单路径。 */
async function readPackageVersion(): Promise<string> {
  try {
    const metadata: unknown = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    if (
      typeof metadata !== 'object' ||
      metadata === null ||
      !('version' in metadata) ||
      typeof metadata.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/i.test(metadata.version)
    ) {
      throw new Error('package.json 缺少有效的 version 字段');
    }
    return metadata.version;
  } catch (cause) {
    throw new Error('服务版本读取失败，请检查部署包中的 package.json', { cause });
  }
}

/** 在 Fastify logger 尚未创建时写出单行结构化启动日志。 */
function writeStartupLog(level: 'fatal' | 'error', message: string, error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({ level, time: new Date().toISOString(), msg: message, err: serializeError(error) })}\n`,
  );
}

/** 把 Error 的关键信息和直接 cause 转成可序列化结构，避免 JSON.stringify 丢失详情。 */
function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) };
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(error.cause === undefined
      ? {}
      : {
          cause:
            error.cause instanceof Error
              ? { name: error.cause.name, message: error.cause.message, stack: error.cause.stack }
              : String(error.cause),
        }),
  };
}
