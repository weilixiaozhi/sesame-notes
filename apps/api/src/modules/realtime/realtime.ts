import { randomBytes } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { WebSocket } from 'ws';

import type { ApiConfig } from '../../shared/api-config.js';
import { authenticate, requireAuth, requireScopes, type AccessClaims } from '../auth/index.js';

import { ApiError } from '../../shared/errors.js';

const MAX_QUEUED_BYTES = 1024 * 1024;
const MAX_CONNECTIONS = 10_000;
const MAX_USER_CONNECTIONS = 32;
const HEARTBEAT_MS = 30_000;

type Ticket = { claims: AccessClaims; expiresAt: number };

export class RealtimeHub {
  private readonly tickets = new Map<string, Ticket>();
  private readonly sockets = new Map<string, Set<WebSocket>>();
  private readonly responsive = new Set<WebSocket>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private heartbeatValidation?: Promise<void>;
  private connectionCount = 0;
  private readonly sessions = new Map<WebSocket, AccessClaims>();

  /** 注入权威会话检查与错误记录，使连接管理不反向依赖账号写入模块。 */
  constructor(
    private readonly checkSession: (claims: AccessClaims) => Promise<boolean>,
    private readonly logError: (error: unknown) => void,
  ) {}

  /** 认证状态读取失败时拒绝发送，避免数据库故障期间沿用过期授权。 */
  async isAuthorized(claims: AccessClaims): Promise<boolean> {
    try {
      return claims.scopes.includes('sync:read') && (await this.checkSession(claims));
    } catch (error) {
      this.logError(error);
      return false;
    }
  }

  /** 按用户范围复核连接和票据；未指定范围时供心跳执行全量安全检查。 */
  async revalidate(userIds?: ReadonlySet<string>): Promise<void> {
    try {
      const checks = new Map<string, Promise<boolean>>();
      const valid = (claims: AccessClaims) => {
        const key = `${claims.userId}:${claims.deviceId}:${claims.authGeneration}:${claims.credentialVersion ?? 0}`;
        let check = checks.get(key);
        if (!check) {
          check = this.isAuthorized(claims);
          checks.set(key, check);
        }
        return check;
      };
      const sessions = userIds
        ? [...userIds].flatMap((userId) =>
            [...(this.sockets.get(userId) ?? [])].map((socket) => [socket, this.sessions.get(socket)!] as const),
          )
        : [...this.sessions];
      for (const [socket, claims] of sessions) {
        if (!(await valid(claims))) socket.close(1008, 'session revoked');
      }
      for (const [ticket, value] of [...this.tickets]) {
        if (userIds && !userIds.has(value.claims.userId)) continue;
        if (value.expiresAt <= Date.now() || !(await valid(value.claims))) this.tickets.delete(ticket);
      }
    } catch (error) {
      this.logError(error);
      this.close();
    }
  }

  /** 签发 30 秒单次票据，避免把 Access Token 放入 WebSocket URL 和访问日志。 */
  issueTicket(claims: AccessClaims): { ticket: string; expires_in: number } {
    try {
      if (this.tickets.size >= MAX_CONNECTIONS) this.removeExpiredTickets();
      if (this.tickets.size >= MAX_CONNECTIONS)
        throw new ApiError(503, 'REALTIME_BUSY', '实时通知暂时繁忙，请稍后重试');
      this.startHeartbeat();
      const ticket = randomBytes(32).toString('base64url');
      this.tickets.set(ticket, { claims, expiresAt: Date.now() + 30_000 });
      return { ticket, expires_in: 30 };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new Error('WEBSOCKET_TICKET_FAILED', { cause: error });
    }
  }

  /** 原子消费单次票据，阻止同一 URL 被复制后重复建立连接。 */
  consumeTicket(ticket: string): AccessClaims | null {
    const stored = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return stored && stored.expiresAt > Date.now() ? stored.claims : null;
  }

  /** 绑定已认证连接，并在关闭时自动移除引用。 */
  attach(claims: AccessClaims, socket: WebSocket): boolean {
    const userId = claims.userId;
    const userSockets = this.sockets.get(userId) ?? new Set<WebSocket>();
    if (userSockets.has(socket)) return true;
    if (userSockets.size >= MAX_USER_CONNECTIONS || this.connectionCount >= MAX_CONNECTIONS) {
      socket.close(1013, 'too many connections');
      return false;
    }
    userSockets.add(socket);
    this.sessions.set(socket, claims);
    this.connectionCount++;
    this.sockets.set(userId, userSockets);
    const onPong = () => this.responsive.add(socket);
    socket.on('pong', onPong);
    this.responsive.add(socket);
    socket.once('close', () => {
      socket.off('pong', onPong);
      this.responsive.delete(socket);
      this.sessions.delete(socket);
      if (userSockets.delete(socket) && this.sockets.get(userId) === userSockets) this.connectionCount--;
      if (userSockets.size === 0 && this.sockets.get(userId) === userSockets) this.sockets.delete(userId);
      this.stopIdleHeartbeat();
    });
    this.startHeartbeat();
    return true;
  }

  /** 一个应用级心跳释放失联连接及过期票据，不为每个连接另建定时器。 */
  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      this.removeExpiredTickets();
      // 慢数据库下只保留一轮全量检查；定向撤销检查独立执行以读取最新状态。
      this.heartbeatValidation ??= this.revalidate().finally(() => {
        this.heartbeatValidation = undefined;
      });
      for (const sockets of this.sockets.values()) {
        for (const socket of sockets) {
          try {
            if (!this.responsive.delete(socket)) socket.terminate();
            else socket.ping();
          } catch {
            socket.terminate();
          }
        }
      }
      this.stopIdleHeartbeat();
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  private stopIdleHeartbeat(): void {
    if (this.connectionCount || this.tickets.size) return;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  /** 向目标用户的所有在线设备发送“重新 Pull”通知，事件本身不作为状态来源。 */
  async publish(userIds: Iterable<string>, payload: Record<string, unknown>): Promise<void> {
    const recipients = new Set(userIds);
    await this.revalidate(recipients);
    this.send(recipients, payload);
  }

  /** 会话已检查后同步发送整个批次，避免每个事件重复查询同一会话。 */
  private send(userIds: Iterable<string>, payload: Record<string, unknown>): void {
    const message = JSON.stringify(payload);
    const messageBytes = Buffer.byteLength(message);
    for (const userId of new Set(userIds)) {
      for (const socket of this.sockets.get(userId) ?? []) {
        try {
          if (socket.readyState !== socket.OPEN) continue;
          if (socket.bufferedAmount + messageBytes > MAX_QUEUED_BYTES) {
            // 通知可由后续游标同步补齐，慢连接不能无界积压占用服务内存。
            socket.terminate();
            continue;
          }
          socket.send(message);
        } catch {
          socket.terminate();
        }
      }
    }
  }

  /** 按本请求明确关联且已提交的同步事件发布“重新 Pull”提示。 */
  async publishForWrite(request: FastifyRequest, prisma: PrismaClient): Promise<void> {
    try {
      if (!request.syncChangeIds?.size) return;
      const changes = await prisma.syncChange.findMany({
        where: { changeId: { in: [...request.syncChangeIds] } },
        orderBy: { changeId: 'asc' },
        select: {
          changeId: true,
          scope: true,
          ledgerId: true,
          entityType: true,
          userId: true,
          recipientUserId: true,
        },
      });
      if (!changes.length) return;

      const ledgerIds = [...new Set(changes.flatMap((change) => (change.ledgerId ? [change.ledgerId] : [])))];
      const categoryOwnerIds = [
        ...new Set(
          changes.flatMap((change) => (change.entityType === 'category' && change.userId ? [change.userId] : [])),
        ),
      ];
      const members =
        ledgerIds.length || categoryOwnerIds.length
          ? await prisma.ledgerMember.findMany({
              where: {
                status: 'ACTIVE',
                OR: [
                  { ledgerId: { in: ledgerIds } },
                  { ledger: { ownerId: { in: categoryOwnerIds }, deletedAt: null } },
                ],
              },
              select: { ledgerId: true, linkedAccountId: true, ledger: { select: { ownerId: true, deletedAt: true } } },
            })
          : [];
      const byLedger = new Map<string, Set<string>>();
      const byOwner = new Map<string, Set<string>>();
      for (const member of members) {
        if (!member.linkedAccountId) continue;
        addRecipient(byLedger, member.ledgerId, member.linkedAccountId);
        // 账本墓碑仍需通知原成员，但已删除账本不能授权后续的账号分类通知。
        if (member.ledger.deletedAt === null) addRecipient(byOwner, member.ledger.ownerId, member.linkedAccountId);
      }

      const serverTime = new Date().toISOString();
      const batchRecipients = new Set<string>();
      for (const change of changes) {
        if (change.userId) batchRecipients.add(change.userId);
        if (change.recipientUserId) batchRecipients.add(change.recipientUserId);
      }
      for (const member of members) {
        if (member.linkedAccountId) batchRecipients.add(member.linkedAccountId);
      }
      // 批次只保留一份用户并集，逐条生成发送对象，避免同时持有重复的成员集合。
      await this.revalidate(batchRecipients);
      for (const change of changes) {
        const recipients = new Set<string>();
        if (change.userId) recipients.add(change.userId);
        if (change.recipientUserId) recipients.add(change.recipientUserId);
        if (change.ledgerId) for (const userId of byLedger.get(change.ledgerId) ?? []) recipients.add(userId);
        if (change.entityType === 'category' && change.userId)
          for (const userId of byOwner.get(change.userId) ?? []) recipients.add(userId);
        this.send(recipients, {
          type: 'sync_change',
          change_id: change.changeId.toString(),
          scope: change.scope,
          ledger_id: change.ledgerId,
          server_time: serverTime,
        });
      }
    } catch (error) {
      request.log.error({ err: error, request_id: request.id }, '实时变更通知失败，通知连接将重建并按游标补拉');
      // 接收人计算失败时不能证明哪些连接已获通知；重建全部在线订阅，让 ready 补拉恢复提交窗口。
      // 不回滚已完成的写入，也不把私有实体放进故障恢复消息。
      for (const sockets of this.sockets.values()) {
        for (const socket of [...sockets]) {
          try {
            socket.close(1012, 'sync recovery required');
          } catch (closeError) {
            this.logError(closeError);
            socket.terminate();
          }
        }
      }
    }
  }

  /** 关闭所有连接并清空短期票据，供服务优雅退出。 */
  close(): void {
    for (const sockets of this.sockets.values()) {
      for (const socket of [...sockets]) socket.terminate();
    }
    this.sockets.clear();
    this.tickets.clear();
    this.responsive.clear();
    this.sessions.clear();
    this.connectionCount = 0;
    this.stopIdleHeartbeat();
  }

  /** 清理过期票据，避免无人消费的票据长期占用内存。 */
  private removeExpiredTickets(): void {
    const now = Date.now();
    for (const [ticket, value] of this.tickets) if (value.expiresAt <= now) this.tickets.delete(ticket);
  }
}

function addRecipient(target: Map<string, Set<string>>, scopeId: string, userId: string): void {
  const recipients = target.get(scopeId) ?? new Set<string>();
  recipients.add(userId);
  target.set(scopeId, recipients);
}

export function registerRealtimeRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  config: ApiConfig,
  hub: RealtimeHub,
): void {
  app.post(
    '/api/v1/ws/ticket',
    {
      preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:read')],
      schema: {
        tags: ['realtime'],
        response: { 200: Type.Object({ ticket: Type.String(), expires_in: Type.Integer() }) },
      },
    },
    async (request) => {
      try {
        return hub.issueTicket(requireAuth(request));
      } catch (error) {
        request.log.error({ err: error, request_id: request.id }, 'WebSocket 票据签发失败');
        throw error;
      }
    },
  );

  app.get(
    '/api/v1/ws',
    {
      websocket: true,
      config: { userAuthentication: 'single-use-websocket-ticket' },
      schema: { hide: true, querystring: Type.Object({ ticket: Type.String({ minLength: 32 }) }) },
    },
    async (socket, request) => {
      try {
        const claims = hub.consumeTicket((request.query as { ticket: string }).ticket);
        if (!claims || !(await hub.isAuthorized(claims))) {
          socket.close(1008, 'invalid ticket');
          return;
        }
        if (socket.readyState !== socket.OPEN || !hub.attach(claims, socket)) return;
        socket.send(JSON.stringify({ type: 'ready', server_time: new Date().toISOString() }));
      } catch (error) {
        request.log.error({ err: error, request_id: request.id }, 'WebSocket 连接建立失败');
        socket.close(1011, 'connection failed');
      }
    },
  );
}
