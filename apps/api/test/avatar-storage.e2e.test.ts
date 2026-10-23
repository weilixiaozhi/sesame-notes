import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { expect, it, vi } from 'vitest';
import { createOwnedFixture, removeOwnedFixture } from './owned-fixture-directory.js';
import { cleanupAvatarFiles, replaceAvatar } from '../src/modules/accounts/testing.js';

it('并发上传和删除保持元数据与文件一致，清理只删除过期孤立文件', async () => {
  const prisma = new PrismaClient({
    datasourceUrl: testFixtureDatabaseUrl(),
  });
  const root = await createOwnedFixture('avatar-storage');
  const log = { warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
  try {
    const user = await prisma.user.create({
      data: {
        phoneE164: `+861${String(Date.now()).slice(-10)}`,
        sesameNumber: String(Math.floor(Math.random() * 900_000_000) + 100_000_000),
        passwordHash: 'fixture',
      },
    });
    const image = { bytes: Buffer.from('test-file'), extension: '.png' as const };
    await Promise.all(Array.from({ length: 6 }, () => replaceAvatar(prisma, root, user.id, image, log)));
    const profile = await prisma.userProfile.findUniqueOrThrow({ where: { userId: user.id } });
    expect(profile.avatarVersion).toBe(6);
    const directory = resolve(root, 'avatars');
    expect(await readdir(directory)).toEqual([profile.avatarFileId]);
    const orphan = `${randomUUID()}.png`;
    const fresh = `${randomUUID()}.png`;
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, orphan), 'orphan');
    await writeFile(resolve(directory, fresh), 'fresh');
    const old = new Date(Date.now() - 48 * 60 * 60_000);
    await utimes(resolve(directory, orphan), old, old);
    await utimes(resolve(directory, profile.avatarFileId!), old, old);
    await cleanupAvatarFiles(prisma, root, log);
    expect((await readdir(directory)).sort()).toEqual([fresh, profile.avatarFileId!].sort());
    await Promise.all([
      replaceAvatar(prisma, root, user.id, image, log),
      replaceAvatar(prisma, root, user.id, null, log),
    ]);
    const current = await prisma.userProfile.findUniqueOrThrow({ where: { userId: user.id } });
    expect((await readdir(directory)).sort()).toEqual(
      [fresh, ...(current.avatarFileId ? [current.avatarFileId] : [])].sort(),
    );
  } catch (error) {
    throw new Error('头像并发与孤立文件回收验证失败', { cause: error });
  } finally {
    // Retain the test account; only this run's owned filesystem fixture is removed.
    await prisma.$disconnect();
    await removeOwnedFixture(root);
  }
});
