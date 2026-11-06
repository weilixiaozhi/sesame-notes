import Fastify from 'fastify';

import { get } from 'node:http';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createOwnedFixture, removeOwnedFixture } from './owned-fixture-directory.js';
import { sendSnapshot, snapshotRows } from '../src/shared/snapshot-stream.js';

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
