import type { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createOwnedFixture, removeOwnedFixture } from './owned-fixture-directory.js';
import { cleanupAvatarFiles, replaceAvatar } from '../src/modules/accounts/testing.js';

it('目录分批扫描不删除正在引用或宽限期内的头像', async () => {
  const root = await createOwnedFixture('avatar-stream');
  const log = { warn: vi.fn(), error: vi.fn() };
  try {
    const directory = resolve(root, 'avatars');
    await mkdir(directory);
    const expired = Array.from({ length: 258 }, () => `${randomUUID()}.png`);
    await Promise.all(
      expired.map(async (name) => {
        const file = resolve(directory, name);
        await writeFile(file, 'image');
        await utimes(file, new Date(0), new Date(0));
      }),
    );
    const fresh = `${randomUUID()}.png`;
    await writeFile(resolve(directory, fresh), 'image');
    const batchSizes: number[] = [];
    const findMany = vi.fn(async ({ where }: { where: { avatarFileId: { in: string[] } } }) => {
      batchSizes.push(where.avatarFileId.in.length);
      return where.avatarFileId.in.includes(expired[0]!) ? [{ avatarFileId: expired[0]! }] : [];
    });
    await cleanupAvatarFiles(
      { userProfile: { findMany } } as unknown as PrismaClient,
      root,
      log as unknown as FastifyBaseLogger,
    );
    expect((await readdir(directory)).sort()).toEqual([expired[0]!, fresh].sort());
    expect(batchSizes).toEqual([256, 2]);
    expect(log.error).not.toHaveBeenCalled();
  } finally {
    await removeOwnedFixture(root);
  }
});

it('提交确认丢失时不删除数据库已经引用的新头像', async () => {
  const root = await createOwnedFixture('avatar-commit');
  let persisted: { avatarFileId: string; avatarVersion: number } | null = null;
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([{ id: randomUUID() }]),
    userProfile: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockImplementation(async ({ create }) => {
        persisted = create;
        return persisted;
      }),
    },
  };
  const prisma = {
    $transaction: async (operation: (value: typeof tx) => Promise<unknown>) => {
      await operation(tx);
      throw new Error('commit acknowledgement lost');
    },
    userProfile: { findUnique: async () => persisted },
  } as unknown as PrismaClient;
  try {
    await expect(
      replaceAvatar(prisma, root, randomUUID(), { bytes: Buffer.from('image'), extension: '.png' }, {
        warn: vi.fn(),
      } as unknown as FastifyBaseLogger),
    ).rejects.toThrow('头像保存失败');
    expect(persisted).not.toBeNull();
    expect(await readdir(resolve(root, 'avatars'))).toEqual([
      (persisted as unknown as { avatarFileId: string }).avatarFileId,
    ]);
  } finally {
    await removeOwnedFixture(root);
  }
});
