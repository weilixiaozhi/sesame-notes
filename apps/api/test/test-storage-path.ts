import { randomUUID } from 'node:crypto';
import { relative, resolve } from 'node:path';

const runDirectory = resolve(import.meta.dirname, '../../../Temp/api-test-storage', randomUUID());

/** 只分配当前运行的根 Temp 路径，不创建目录；同套件的多个应用共用路径，独立运行互相隔离。 */
export function testStoragePath(suite: string): string {
  try {
    if (
      !/^[a-z][a-z0-9.-]{0,100}$/.test(suite) ||
      suite.endsWith('.') ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(suite)
    ) {
      throw new Error('测试存储目录名称必须是普通套件名称，不能包含路径或保留设备名');
    }
    const path = resolve(runDirectory, suite);
    if (relative(runDirectory, path) !== suite) throw new Error('测试存储路径超出当前运行目录');
    return path;
  } catch (cause) {
    throw new Error('测试存储目录解析失败', { cause });
  }
}
