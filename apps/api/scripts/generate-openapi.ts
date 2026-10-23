import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildApp } from '../src/app.js';

/** 只装配真实路由并返回契约，不监听端口、不改动契约文件。 */
export async function generateOpenApiDocument(): Promise<string> {
  let app: ReturnType<typeof buildApp> | undefined;
  let document = '';
  const failures: unknown[] = [];
  try {
    app = buildApp({
      logger: false,
      config: {
        databaseUrl: 'postgresql://contract:contract@localhost:5432/contract',
        jwtSecret: 'openapi-generation-secret-not-used-at-runtime',
        accessTokenTtlSeconds: 900,
        refreshTokenTtlSeconds: 2_592_000,
        storagePath: '.openapi-storage',
        exchangeRateUpstream: 'https://api.frankfurter.dev',
        exchangeRateCacheTtlSeconds: 43_200,
        githubReleaseToken: '',
        port: 8080,
        host: '127.0.0.1',
        corsOrigins: [],
        rateLimitMax: 300,
        authRateLimitMax: 10,
        syncRetentionMinCursor: 0,
        trustProxyCidrs: [],
      },
    });
    await app.ready();
    document = `${JSON.stringify(app.swagger(), null, 2)}\n`;
  } catch (cause) {
    failures.push(new Error('OpenAPI 路由装配失败', { cause }));
  } finally {
    try {
      await app?.close();
    } catch (cause) {
      failures.push(new Error('OpenAPI 生成后的资源清理失败', { cause }));
    }
  }
  if (failures.length) throw new AggregateError(failures, 'OpenAPI 生成未完成，请检查路由装配与资源清理错误');
  return document;
}

/** 输出目标必须显式互斥；stdout 模式只输出 JSON，供无副作用的契约检查使用。 */
async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2);
    const stdout = args.length === 1 && args[0] === '--stdout';
    const explicitOutput = args.length === 2 && args[0] === '--output' && args[1] && !args[1].startsWith('--');
    if (args.length && !stdout && !explicitOutput) {
      throw new Error('用法：openapi:generate [--stdout | --output <文件路径>]');
    }
    const document = await generateOpenApiDocument();
    if (stdout) {
      process.stdout.write(document);
      return;
    }
    const output = explicitOutput
      ? resolve(args[1]!)
      : resolve(import.meta.dirname, '../../../packages/api-contract/openapi.json');
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, document, 'utf8');
  } catch (error) {
    console.error('OpenAPI 生成失败，请检查参数和路由声明。', error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
