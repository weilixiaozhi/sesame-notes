import Fastify from 'fastify';
import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';
import { createOwnedFixture, removeOwnedFixture } from './owned-fixture-directory.js';
import { sendSnapshot, snapshotRows } from '../src/shared/snapshot-stream.js';
import { runWithOperationMetrics, type OperationMetrics } from '../src/shared/operation-metrics.js';

it('快照生成指标在真实 onResponse 写日志前可见，失败生成也留下记录', async () => {
  const f = await fixture();
  const observed: OperationMetrics[] = [];
  f.app.decorateRequest('operationMetrics');
  f.app.addHook('onRequest', (request, _reply, done) => {
    request.operationMetrics = {};
    runWithOperationMetrics(request.operationMetrics, done);
  });
  f.app.addHook('onResponse', async (request) => {
    observed.push(structuredClone(request.operationMetrics));
  });
  f.app.get('/full', (_, reply) =>
    sendSnapshot(reply, f.directory, async (writer) => {
      await writer.text('{"value":1}');
    }),
  );
  f.app.get('/failed', (_, reply) =>
    sendSnapshot(reply, f.directory, async () => {
      throw new Error('snapshot generation failed');
    }),
  );
  try {
    expect((await f.app.inject('/full')).statusCode).toBe(200);
    expect((await f.app.inject('/failed')).statusCode).toBe(500);
    expect(observed[0]?.snapshot).toMatchObject({ count: 1, failed: 0, bytes: 11 });
    expect(observed[1]?.snapshot).toMatchObject({ count: 1, failed: 1 });
  } finally {
    await f.close();
  }
});

async function fixture() {
  const directory = await createOwnedFixture('snapshot-stream-test');
  const app = Fastify({ logger: false });
  return {
    directory,
    app,
    async close() {
      await app.close();
      await removeOwnedFixture(directory);
    },
  };
}
async function waitEmpty(directory: string) {
  for (let i = 0; i < 100; i++) {
    if ((await readdir(join(directory, 'sync-snapshots'))).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await readdir(join(directory, 'sync-snapshots'))).toEqual([]);
}
it('完整 JSON 与主键分页一致，成功后释放文件', async () => {
  const f = await fixture();
  const content = '中文😀'.repeat(1000);
  const pages: number[] = [];
  f.app.get('/full', (_, reply) =>
    sendSnapshot(reply, f.directory, async (writer) => {
      await writer.text('{"rows":');
      await writer.array(
        snapshotRows(async (cursor, take) => {
          pages.push(take);
          const start = cursor ? Number(cursor) + 1 : 0;
          return Array.from({ length: Math.min(take, 200 - start) }, (_, i) => ({ id: String(start + i), content }));
        }, 16),
      );
      await writer.text('}');
    }),
  );
  try {
    const response = await f.app.inject('/full');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ rows: Array.from({ length: 200 }, (_, i) => ({ id: String(i), content })) });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page === 16)).toBe(true);
    await waitEmpty(f.directory);
  } finally {
    await f.close();
  }
});
it('生成中途失败不发送半份成功响应，并清理临时文件', async () => {
  const f = await fixture();
  f.app.get('/full', (_, reply) =>
    sendSnapshot(reply, f.directory, async (writer) => {
      await writer.text('{"private_partial":');
      throw new Error('injected');
    }),
  );
  try {
    const response = await f.app.inject('/full');
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('private_partial');
    await waitEmpty(f.directory);
  } finally {
    await f.close();
  }
});
it('客户端在生成期间退出，后续写入停止并释放文件', async () => {
  const f = await fixture();
  let enter!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  f.app.get('/full', (_, reply) =>
    sendSnapshot(reply, f.directory, async (writer) => {
      await writer.text('[');
      enter();
      await gate;
      await writer.text(']');
    }),
  );
  try {
    const address = await f.app.listen({ port: 0, host: '127.0.0.1' });
    const request = get(`${address}/full`);
    request.on('error', () => {});
    await entered;
    request.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    resume();
    await waitEmpty(f.directory);
  } finally {
    resume?.();
    await f.close();
  }
});
it('客户端在传输期间退出也释放快照文件', async () => {
  const f = await fixture();
  f.app.get('/full', (_, reply) =>
    sendSnapshot(reply, f.directory, async (writer) => {
      await writer.text('{"rows":');
      await writer.array(Array.from({ length: 500 }, (_, id) => ({ id, text: 'x'.repeat(8192) })));
      await writer.text('}');
    }),
  );
  try {
    const address = await f.app.listen({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve, reject) => {
      const request = get(`${address}/full`, (response) => {
        response.once('data', () => {
          request.destroy();
          resolve();
        });
      });
      request.on('error', (error) => {
        if (!request.destroyed) reject(error);
      });
    });
    await waitEmpty(f.directory);
  } finally {
    await f.close();
  }
});

/** 子进程在首个大块写入后直接退出，确保验证不会依赖请求的 finally 清理。 */
async function crashAfterFirstChunk(directory: string): Promise<void> {
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stdout = '';
  let stderr = '';
  try {
    const source = `
      import Fastify from 'fastify';
      try {
        const { sendSnapshot } = await import(process.argv[2]);
        const app = Fastify({ logger: false });
        app.get('/full', (_, reply) => sendSnapshot(reply, process.argv[1], async (writer) => {
          await writer.text('{"private_content":"' + 'x'.repeat(128 * 1024));
          await writer.flush();
          await new Promise((resolve) => process.stdout.write('FIRST_CHUNK_WRITTEN\\n', resolve));
          process.exit(42);
        }));
        await app.inject('/full');
        throw new Error('快照子进程没有在指定阶段退出');
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
      }
    `;
    child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        source,
        directory,
        new URL('../src/shared/snapshot-stream.ts', import.meta.url).href,
      ],
      { cwd: resolve(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    exited = new Promise((resolve, reject) => {
      child!.once('error', reject);
      // 等待输出管道关闭后再检查标记，避免进程退出事件早于最后一段日志读取。
      child!.once('close', (code, signal) => resolve({ code, signal }));
    });
    const outcome = await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('快照崩溃子进程等待超过 15 秒')), 15_000);
      }),
    ]);
    expect(outcome).toEqual({ code: 42, signal: null });
    expect(stdout).toContain('FIRST_CHUNK_WRITTEN');
  } catch (error) {
    throw new Error(`快照崩溃回归失败。\nstdout:\n${stdout}\nstderr:\n${stderr}`, { cause: error });
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited?.catch(() => {});
  }
}

it('生成首个大块后进程崩溃，操作系统回收快照内容', async () => {
  const f = await fixture();
  try {
    await crashAfterFirstChunk(f.directory);
    const entries = await readdir(join(f.directory, 'sync-snapshots'), { recursive: true, withFileTypes: true });
    // 崩溃跳过应用清理，已写入的私有内容仍不能留下可访问的文件。
    expect(entries.filter((entry) => entry.isFile())).toEqual([]);
  } catch (error) {
    throw new Error('生成阶段崩溃后的快照内容残留检查失败', { cause: error });
  } finally {
    await f.close();
  }
}, 20_000);

it('两个快照并发生成，一个完成后另一下载仍保持完整', async () => {
  const f = await fixture();
  let enterFirst!: () => void;
  let enterSecond!: () => void;
  let resumeFirst!: () => void;
  let resumeSecond!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    enterFirst = resolve;
  });
  const secondEntered = new Promise<void>((resolve) => {
    enterSecond = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    resumeFirst = resolve;
  });
  const secondGate = new Promise<void>((resolve) => {
    resumeSecond = resolve;
  });
  const content = '并发私有快照😀'.repeat(16_000);
  const requests: Array<Promise<unknown>> = [];
  f.app.get<{ Params: { name: string } }>('/full/:name', (request, reply) =>
    sendSnapshot(reply, f.directory, async (writer) => {
      const first = request.params.name === 'first';
      await writer.text(`{"name":${JSON.stringify(request.params.name)},"content":`);
      await writer.value(content);
      // 两个请求均已落盘后才放行首个响应，随后验证另一句柄未被清理影响。
      (first ? enterFirst : enterSecond)();
      await (first ? firstGate : secondGate);
      await writer.text('}');
    }),
  );
  try {
    const first = f.app.inject('/full/first').then((response) => response);
    requests.push(first);
    await Promise.race([
      firstEntered,
      first.then(() => {
        throw new Error('首个快照未进入生成阶段就已结束');
      }),
    ]);
    const second = f.app.inject('/full/second').then((response) => response);
    requests.push(second);
    await Promise.race([
      secondEntered,
      second.then(() => {
        throw new Error('第二个快照未进入生成阶段就已结束');
      }),
    ]);
    resumeFirst();
    const firstResponse = await first;
    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.json()).toEqual({ name: 'first', content });
    resumeSecond();
    const secondResponse = await second;
    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()).toEqual({ name: 'second', content });
    await waitEmpty(f.directory);
  } catch (error) {
    throw new Error('并发快照下载完整性检查失败', { cause: error });
  } finally {
    resumeFirst();
    resumeSecond();
    await Promise.allSettled(requests);
    await f.close();
  }
});

it('快照请求保留未知所有者及其他 PID 前缀目录中的内容', async () => {
  const f = await fixture();
  const root = join(f.directory, 'sync-snapshots');
  const foreignDirectories = ['2147483647-other-instance', 'unknown-owner'];
  const foreignContent = '属于其他实例的快照内容，不由当前请求清理';
  try {
    for (const name of foreignDirectories) {
      await mkdir(join(root, name), { recursive: true });
      await writeFile(join(root, name, 'snapshot.json'), foreignContent);
    }
    f.app.get('/full', (_, reply) => sendSnapshot(reply, f.directory, (writer) => writer.value({ ok: true })));
    const response = await f.app.inject('/full');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    for (const name of foreignDirectories) {
      expect(await readFile(join(root, name, 'snapshot.json'), 'utf8')).toBe(foreignContent);
    }
  } catch (error) {
    throw new Error('跨实例快照目录保护检查失败', { cause: error });
  } finally {
    await f.close();
  }
});
