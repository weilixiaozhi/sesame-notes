import type { PrismaClient } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi, onTestFinished } from 'vitest';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';

import type { AccessClaims } from '../src/modules/auth/index.js';
import { RealtimeHub } from '../src/modules/realtime/index.js';
import { recordSyncChangeId, runWithRealtimeContext } from '../src/shared/realtime-context.js';

/** 构造独立设备会话，保留连接需要的身份、代际和资源权限。 */
function claimsFor(userId: string, deviceId = 'device'): AccessClaims {
  return { userId, deviceId, authGeneration: 'generation', credentialVersion: 0, scopes: ['sync:read'] };
}

/** 创建只记录发送内容的 WebSocket 替身。 */
function fakeSocket(): WebSocket & { send: ReturnType<typeof vi.fn> } {
  const events = new EventEmitter();
  return Object.assign(events, {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn(),
    ping: vi.fn(),
    close: vi.fn(() => events.emit('close')),
    terminate: vi.fn(() => events.emit('close')),
  }) as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };
}

/** 创建 onResponse 所需的最小请求替身。 */
function fakeRequest(overrides: Record<string, unknown> = {}): FastifyRequest {
  return {
    id: 'request-id',
    method: 'POST',
    url: '/api/v1/invites/CODE/accept',
    params: {},
    body: {},
    auth: {
      userId: 'actor',
      deviceId: 'device',
      authGeneration: 'generation',
      credentialVersion: 0,
      scopes: ['sync:write'],
    },
    log: { error: vi.fn() },
    ...overrides,
  } as unknown as FastifyRequest;
}

describe('实时同步提示', () => {
  it('已提交事件的通知查询失败时重建订阅，避免在线连接永久错过变更', async () => {
    const hub = new RealtimeHub(async () => true, vi.fn());
    onTestFinished(() => hub.close());
    const peer = fakeSocket();
    hub.attach(claimsFor('peer'), peer);
    const failure = new Error('notification query temporarily unavailable');
    const prisma = {
      syncChange: { findMany: vi.fn().mockRejectedValue(failure) },
    } as unknown as PrismaClient;
    const request = fakeRequest({ syncChangeIds: new Set([1n]) });
    await expect(hub.publishForWrite(request, prisma)).resolves.toBeUndefined();
    expect(peer.close).toHaveBeenCalledWith(1012, 'sync recovery required');
    expect(peer.send).not.toHaveBeenCalled();
    expect(request.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: failure, request_id: 'request-id' }),
      expect.any(String),
    );
  });
  it('已删除的共享账本只传递账本墓碑提示，不再授予账号分类提示权限', async () => {
    const hub = new RealtimeHub(async () => true, vi.fn());
    onTestFinished(() => hub.close());
    const peer = fakeSocket();
    hub.attach(claimsFor('peer'), peer);
    const prisma = {
      syncChange: {
        findMany: vi.fn().mockResolvedValue([
          {
            changeId: 1n,
            scope: 'ledger',
            ledgerId: 'deleted',
            entityType: 'ledger',
            userId: 'owner',
            recipientUserId: null,
          },
          {
            changeId: 2n,
            scope: 'user',
            ledgerId: null,
            entityType: 'category',
            userId: 'owner',
            recipientUserId: null,
          },
        ]),
      },
      ledgerMember: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { ledgerId: 'deleted', linkedAccountId: 'peer', ledger: { ownerId: 'owner', deletedAt: new Date() } },
          ]),
      },
    } as unknown as PrismaClient;
    await hub.publishForWrite(fakeRequest({ syncChangeIds: new Set([1n, 2n]) }), prisma);
    expect(peer.send.mock.calls.map(([message]) => JSON.parse(message as string).change_id)).toEqual(['1']);
  });
  it('百个在线用户的定向通知只检查接收方，并合并同设备连接和票据', async () => {
    const checkSession = vi.fn().mockResolvedValue(true);
    const hub = new RealtimeHub(checkSession, vi.fn());
    onTestFinished(() => hub.close());
    for (let i = 0; i < 100; i++) hub.attach(claimsFor(`user-${i}`), fakeSocket());
    hub.attach(claimsFor('user-0'), fakeSocket());
    hub.issueTicket(claimsFor('user-0'));
    hub.issueTicket(claimsFor('user-99'));

    await hub.publish(['user-0', 'user-0'], { type: 'sync_change' });

    expect(checkSession).toHaveBeenCalledExactlyOnceWith(claimsFor('user-0'));
    checkSession.mockClear();
    await Promise.all(Array.from({ length: 10 }, () => hub.publish(['user-0'], { type: 'sync_change' })));
    expect(checkSession).toHaveBeenCalledTimes(10);
    expect(checkSession.mock.calls.every(([claims]) => claims.userId === 'user-0')).toBe(true);
  });

  it('定向撤销只关闭目标用户连接并作废其票据', async () => {
    const checkSession = vi.fn().mockResolvedValue(false);
    const hub = new RealtimeHub(checkSession, vi.fn());
    onTestFinished(() => hub.close());
    const target = fakeSocket();
    const other = fakeSocket();
    hub.attach(claimsFor('target'), target);
    hub.attach(claimsFor('other'), other);
    const targetTicket = hub.issueTicket(claimsFor('target'));
    const otherTicket = hub.issueTicket(claimsFor('other'));

    await hub.revalidate(new Set(['target']));

    expect(target.close).toHaveBeenCalledWith(1008, 'session revoked');
    expect(other.close).not.toHaveBeenCalled();
    expect(hub.consumeTicket(targetTicket.ticket)).toBeNull();
    expect(hub.consumeTicket(otherTicket.ticket)).toEqual(claimsFor('other'));
    expect(checkSession).toHaveBeenCalledExactlyOnceWith(claimsFor('target'));
  });

  it.each([true, false])('同设备新旧凭据版本分别复核连接和票据，先检查新版本：%s', async (currentFirst) => {
    const checkSession = vi.fn(async (claims: AccessClaims) => claims.credentialVersion === 1);
    const hub = new RealtimeHub(checkSession, vi.fn());
    onTestFinished(() => hub.close());
    try {
      const oldClaims = claimsFor('target');
      const currentClaims = { ...oldClaims, credentialVersion: 1 };
      const oldSocket = fakeSocket();
      const currentSocket = fakeSocket();
      const connections = [
        [oldClaims, oldSocket],
        [currentClaims, currentSocket],
      ] as const;
      for (const [claims, socket] of currentFirst ? [...connections].reverse() : connections)
        hub.attach(claims, socket);
      const oldTicket = hub.issueTicket(oldClaims);
      const currentTicket = hub.issueTicket(currentClaims);

      await hub.revalidate(new Set(['target']));

      expect(oldSocket.close).toHaveBeenCalledWith(1008, 'session revoked');
      expect(currentSocket.close).not.toHaveBeenCalled();
      expect(hub.consumeTicket(oldTicket.ticket)).toBeNull();
      expect(hub.consumeTicket(currentTicket.ticket)).toEqual(currentClaims);
      expect(checkSession).toHaveBeenCalledTimes(2);
    } catch (cause) {
      throw new Error('实时连接凭据版本隔离验收失败', { cause });
    }
  });

  it('慢会话检查期间心跳不重叠执行全量查询，完成后下一轮恢复检查', async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<boolean>();
    const checkSession = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(true);
    const hub = new RealtimeHub(checkSession, vi.fn());
    onTestFinished(() => {
      hub.close();
      vi.useRealTimers();
    });
    const socket = fakeSocket();
    hub.attach(claimsFor('user'), socket);
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(30000);
      socket.emit('pong');
    }
    expect(checkSession).toHaveBeenCalledTimes(1);
    pending.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30000);
    expect(checkSession).toHaveBeenCalledTimes(2);
  });

  it('撤销设备后不发送消息，同时作废票据，其他设备仍可接收', async () => {
    const revoked = new Set<string>();
    const hub = new RealtimeHub(async (claims) => !revoked.has(claims.deviceId), vi.fn());
    onTestFinished(() => hub.close());
    const first = fakeSocket();
    const second = fakeSocket();
    hub.attach(claimsFor('user', 'first'), first);
    hub.attach(claimsFor('user', 'second'), second);
    const ticket = hub.issueTicket(claimsFor('user', 'first'));
    revoked.add('first');
    await hub.publish(['user'], { type: 'sync_change' });
    expect(first.close).toHaveBeenCalledWith(1008, 'session revoked');
    expect(first.send).not.toHaveBeenCalled();
    expect(second.send).toHaveBeenCalledOnce();
    expect(hub.consumeTicket(ticket.ticket)).toBeNull();
  });

  it('账号禁用或代际变化会使握手和存量连接均失效', async () => {
    let enabled = true;
    let generation = 'generation';
    const hub = new RealtimeHub(async (claims) => enabled && claims.authGeneration === generation, vi.fn());
    onTestFinished(() => hub.close());
    const socket = fakeSocket();
    hub.attach(claimsFor('user'), socket);
    generation = 'next-generation';
    await hub.revalidate();
    expect(socket.close).toHaveBeenCalledWith(1008, 'session revoked');
    expect(await hub.isAuthorized(claimsFor('user'))).toBe(false);
    generation = 'generation';
    enabled = false;
    expect(await hub.isAuthorized(claimsFor('user'))).toBe(false);
  });

  it('安全状态查询失败时关闭连接并记录错误，不能继续发送', async () => {
    const failure = new Error('database unavailable');
    const log = vi.fn();
    const hub = new RealtimeHub(async () => {
      throw failure;
    }, log);
    onTestFinished(() => hub.close());
    const socket = fakeSocket();
    hub.attach(claimsFor('user'), socket);
    await hub.publish(['user'], { type: 'sync_change' });
    expect(log).toHaveBeenCalledWith(failure);
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(1008, 'session revoked');
  });

  it('慢连接达到发送预算即释放，其他连接正常接收', async () => {
    const hub = new RealtimeHub(async () => true, vi.fn());
    onTestFinished(() => hub.close());
    const slow = fakeSocket();
    const fast = fakeSocket();
    Object.assign(slow, { bufferedAmount: 1024 * 1024 });
    hub.attach(claimsFor('user'), slow);
    hub.attach(claimsFor('user'), fast);
    await hub.publish(['user'], { type: 'sync_change' });
    expect(slow.terminate).toHaveBeenCalledOnce();
    expect(slow.send).not.toHaveBeenCalled();
    expect(fast.send).toHaveBeenCalledOnce();
    await hub.publish(['user'], { type: 'sync_change' });
    expect(slow.terminate).toHaveBeenCalledOnce();
  });
  it('心跳淘汰失联连接，关闭后不遗留定时器', () => {
    vi.useFakeTimers();
    const hub = new RealtimeHub(async () => true, vi.fn());
    onTestFinished(() => {
      hub.close();
      vi.useRealTimers();
    });
    const socket = fakeSocket();
    hub.attach(claimsFor('user'), socket);
    vi.advanceTimersByTime(30000);
    expect(socket.ping).toHaveBeenCalledOnce();
    socket.emit('pong');
    vi.advanceTimersByTime(30000);
    expect(socket.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30000);
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('同账号连接设上限，释放后允许再次连接', () => {
    const hub = new RealtimeHub(async () => true, vi.fn());
    onTestFinished(() => hub.close());
    const sockets = Array.from({ length: 32 }, () => fakeSocket());
    sockets.forEach((s) => expect(hub.attach(claimsFor('user'), s)).toBe(true));
    const excess = fakeSocket();
    expect(hub.attach(claimsFor('user'), excess)).toBe(false);
    expect(excess.close).toHaveBeenCalledWith(1013, 'too many connections');
    sockets[0]!.emit('close');
    expect(hub.attach(claimsFor('user'), fakeSocket())).toBe(true);
  });

  it('并发请求分别记录自己的 change_id', async () => {
    const first = new Set<bigint>();
    const second = new Set<bigint>();

    await Promise.all([
      new Promise<void>((resolve) => {
        runWithRealtimeContext(first, () => {
          setImmediate(() => {
            recordSyncChangeId(1n);
            resolve();
          });
        });
      }),
      new Promise<void>((resolve) => {
        runWithRealtimeContext(second, () => {
          queueMicrotask(() => {
            recordSyncChangeId(2n);
            resolve();
          });
        });
      }),
    ]);

    expect([...first]).toEqual([1n]);
    expect([...second]).toEqual([2n]);
  });

  it('只按显式关联的 change_id 发布，不从 URL/body 猜测', async () => {
    const hub = new RealtimeHub(async () => true, vi.fn());
    onTestFinished(() => hub.close());
    const actorSocket = fakeSocket();
    hub.attach(claimsFor('actor'), actorSocket);
    const prisma = {
      syncChange: { findMany: vi.fn() },
      ledgerMember: { findMany: vi.fn() },
    } as unknown as PrismaClient;
    const request = fakeRequest({ url: '/api/v1/categories', body: { changes: [{ entity_type: 'category' }] } });

    await hub.publishForWrite(request, prisma);

    expect(actorSocket.send).not.toHaveBeenCalled();
    expect(prisma.syncChange.findMany).not.toHaveBeenCalled();
    expect(prisma.ledgerMember.findMany).not.toHaveBeenCalled();
  });

  it('邀请路径也按已提交 ledger 事件通知成员，并携带精确 change_id', async () => {
    const hub = new RealtimeHub(async () => true, vi.fn());
    onTestFinished(() => hub.close());
    const ownerSocket = fakeSocket();
    hub.attach(claimsFor('owner'), ownerSocket);
    const findChanges = vi.fn().mockResolvedValue([
      {
        changeId: 42n,
        scope: 'ledger',
        ledgerId: 'ledger-id',
        entityType: 'member',
        userId: 'actor',
        recipientUserId: 'actor',
      },
    ]);
    const findMembers = vi
      .fn()
      .mockResolvedValue([{ ledgerId: 'ledger-id', linkedAccountId: 'owner', ledger: { ownerId: 'owner' } }]);
    const prisma = {
      syncChange: { findMany: findChanges },
      ledgerMember: { findMany: findMembers },
    } as unknown as PrismaClient;
    const request = fakeRequest({ syncChangeIds: new Set([42n]) });

    await hub.publishForWrite(request, prisma);

    expect(ownerSocket.send).toHaveBeenCalledOnce();
    expect(JSON.parse(ownerSocket.send.mock.calls[0]![0] as string)).toMatchObject({
      type: 'sync_change',
      change_id: '42',
      scope: 'ledger',
      ledger_id: 'ledger-id',
    });
  });

  it('事务回滚后查不到事件时不发布提示', async () => {
    const hub = new RealtimeHub(async () => true, vi.fn());
    onTestFinished(() => hub.close());
    const actorSocket = fakeSocket();
    hub.attach(claimsFor('actor'), actorSocket);
    const prisma = {
      syncChange: { findMany: vi.fn().mockResolvedValue([]) },
      ledgerMember: { findMany: vi.fn() },
    } as unknown as PrismaClient;

    await hub.publishForWrite(fakeRequest({ syncChangeIds: new Set([99n]) }), prisma);

    expect(actorSocket.send).not.toHaveBeenCalled();
    expect(prisma.ledgerMember.findMany).not.toHaveBeenCalled();
  });

  it('批量写入按每个已提交事件分别发布提示', async () => {
    const checkSession = vi.fn().mockResolvedValue(true);
    const hub = new RealtimeHub(checkSession, vi.fn());
    onTestFinished(() => hub.close());
    const actorSocket = fakeSocket();
    const formerMemberSocket = fakeSocket();
    hub.attach(claimsFor('actor'), actorSocket);
    hub.attach(claimsFor('former-member'), formerMemberSocket);
    hub.attach(claimsFor('unrelated'), fakeSocket());
    const prisma = {
      syncChange: {
        findMany: vi.fn().mockResolvedValue([
          {
            changeId: 7n,
            scope: 'user',
            ledgerId: null,
            entityType: 'profile',
            userId: 'actor',
            recipientUserId: 'former-member',
          },
          {
            changeId: 8n,
            scope: 'user',
            ledgerId: null,
            entityType: 'profile',
            userId: 'actor',
            recipientUserId: null,
          },
        ]),
      },
      ledgerMember: { findMany: vi.fn() },
    } as unknown as PrismaClient;

    await hub.publishForWrite(fakeRequest({ syncChangeIds: new Set([7n, 8n]) }), prisma);

    expect(actorSocket.send).toHaveBeenCalledTimes(2);
    expect(actorSocket.send.mock.calls.map(([message]) => JSON.parse(message as string).change_id)).toEqual(['7', '8']);
    expect(formerMemberSocket.send).toHaveBeenCalledOnce();
    expect(JSON.parse(formerMemberSocket.send.mock.calls[0]![0] as string).change_id).toBe('7');
    expect(checkSession).toHaveBeenCalledTimes(2);
    expect(checkSession.mock.calls.map(([claims]) => claims.userId)).toEqual(['actor', 'former-member']);
  });
});
