import { randomUUID } from 'node:crypto';
import { finished } from 'node:stream/promises';
import { mkdir, open, unlink, type FileHandle } from 'node:fs/promises';

import { join, resolve } from 'node:path';
import type { FastifyReply } from 'fastify';
import { ApiError } from './errors.js';
import { recordOperationMetric } from './operation-metrics.js';

/** 将完整快照逐段写入私有临时文件，响应仍是同一个 v1 JSON，不返回半份快照。 */
export class SnapshotWriter {
  private parts: string[] = [];
  private bytes = 0;
  constructor(
    private readonly file: FileHandle,
    private readonly cancelled: () => boolean,
  ) {}
  async text(value: string): Promise<void> {
    if (this.cancelled()) throw new ApiError(499, 'SNAPSHOT_CANCELLED', '下载已取消');
    this.parts.push(value);
    this.bytes += Buffer.byteLength(value);
    if (this.bytes >= 64 * 1024) await this.flush();
  }
  async value<T>(value: T, serialize: (value: T) => string = JSON.stringify): Promise<void> {
    await this.text(serialize(value));
  }
  async array<T>(
    values: Iterable<T> | AsyncIterable<T>,
    serialize: (value: T) => string = JSON.stringify,
  ): Promise<void> {
    await this.text('[');
    let first = true;
    for await (const value of values) {
      if (!first) await this.text(',');
      first = false;
      await this.value(value, serialize);
    }
    await this.text(']');
  }
  async flush(): Promise<void> {
    if (!this.parts.length) return;
    await this.file.writeFile(this.parts.join(''));
    this.parts = [];
    this.bytes = 0;
  }
}

/** 主键游标保持同一只读事务视图，限制每轮中间对象数量。 */
export async function* snapshotRows<T extends { id: string }>(
  load: (cursor: string | undefined, take: number) => Promise<T[]>,
  pageSize = 256,
): AsyncGenerator<T> {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError('无效快照批次');
  let cursor: string | undefined;
  while (true) {
    const rows = await load(cursor, pageSize);
    if (!rows.length) return;
    yield* rows;
    const next = rows.at(-1)!.id;
    if (next === cursor) throw new Error('快照游标没有推进');
    cursor = next;
    if (rows.length < pageSize) return;
  }
}

/** 先解除临时文件的路径引用，再生成完整快照；句柄关闭或进程退出时由操作系统回收内容。 */
export async function sendSnapshot(
  reply: FastifyReply,
  storagePath: string,
  produce: (writer: SnapshotWriter) => Promise<void>,
): Promise<void> {
  let file: FileHandle | undefined;
  let linkedPath: string | undefined;
  const started = performance.now();
  let measured = false;
  let size = 0;
  try {
    const root = resolve(storagePath, 'sync-snapshots');
    await mkdir(root, { recursive: true });
    const path = join(root, `${randomUUID()}.json`);
    file = await open(path, 'wx+', 0o600);
    linkedPath = path;
    // 私有内容只写入已解除路径引用的文件，进程被强制终止也不会留下可命名的快照。
    // 后续写入、长度查询和发送始终使用同一文件句柄，不依赖 PID 或其他实例的目录状态。
    await unlink(path);
    linkedPath = undefined;
    const writer = new SnapshotWriter(file, () => reply.raw.destroyed);
    await produce(writer);
    await writer.flush();
    if (reply.raw.destroyed) return;
    size = (await file.stat()).size;
    const stream = file.createReadStream({ start: 0, autoClose: false });
    const closed = finished(stream, { cleanup: true }).catch(() => {});
    /** 客户端连接关闭时停止读取，让发送流程尽快释放快照句柄。 */
    const onClose = () => stream.destroy();
    reply.raw.once('close', onClose);
    try {
      reply.type('application/json').header('content-length', size);
      // 生成指标必须在发送前完成，onResponse 会在 reply.send 的 Promise 返回前写出请求日志。
      // 网络传输成败由 HTTP 响应日志记录，此项只描述完整快照构建。
      recordOperationMetric('snapshot', performance.now() - started, true, 0, size);
      measured = true;
      await reply.send(stream);
    } finally {
      reply.raw.off('close', onClose);
      stream.destroy();
      await closed;
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('完整快照生成或发送失败', { cause: error });
  } finally {
    if (!measured) recordOperationMetric('snapshot', performance.now() - started, false, 0, size);
    // 流销毁也可能关闭底层句柄；close 可重复等待，生成失败与客户端取消都走同一回收路径。
    await file?.close().catch((error) => reply.log.warn({ err: error }, '快照文件句柄关闭失败'));
    // 解除路径引用失败时文件尚未承载私有内容，只补偿删除本请求实际创建的空文件。
    if (linkedPath) {
      await unlink(linkedPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') reply.log.warn({ err: error }, '快照空文件清理失败');
      });
    }
  }
}
