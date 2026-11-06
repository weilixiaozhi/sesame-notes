import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { adminAuditConditions, adminAuditResponse } from './admin-audit.js';
import { writeAuditLog } from './audit-log.js';

describe('后台审计数据安全', () => {
  it('日志筛选绑定参数，通配符和注入文本不能扩大查询', () => {
    try {
      const condition = adminAuditConditions({ actor_search: "x%' OR TRUE --", target_search: '用户_' });
      expect(condition.sql).not.toContain('OR TRUE');
      expect(condition.values).toContain("%x\\%' OR TRUE --%");
      expect(condition.values).toContain('%用户\\_%');
    } catch (cause) {
      throw new Error('审计筛选参数安全验证失败', { cause });
    }
  });

  it('日志响应只发布白名单摘要，未知事件和自由文本不泄露凭据或手机号', () => {
    try {
      const row = {
        id: 9007199254740993n,
        action: 'admin.password.reset',
        ip: null,
        created_at: new Date('2026-10-09T01:00:00Z'),
        actor_display: 'ops_test',
        target_display: 'operator_a',
        metadata: { reason: '用户申请 +8613800138000', password: 'secret-password', token: 'secret-token' },
      };
      const value = adminAuditResponse(row);
      expect(value.id).toBe('9007199254740993');
      expect(JSON.stringify(value)).not.toContain('secret-');
      expect(value.reason).not.toContain('+8613800138000');
      expect(adminAuditResponse({ ...row, action: 'unknown' })).toMatchObject({ summary: null, reason: null });
    } catch (cause) {
      throw new Error('审计响应秘密脱敏验证失败', { cause });
    }
  });

  it('审计落库前递归移除凭据键并脱敏完整手机号', async () => {
    try {
      const db = {
        adminAccount: { findUnique: vi.fn().mockResolvedValue({ username: 'ops_test' }) },
        user: {
          findUnique: vi.fn().mockResolvedValue({ sesameNumber: '123456789', profile: { displayName: '小芝麻' } }),
        },
        auditLog: { create: vi.fn().mockResolvedValue({}) },
      };
      await writeAuditLog(db as unknown as PrismaClient, {
        actor: 'admin:operator',
        action: 'user.disable',
        target: { type: 'user', id: 'user' },
        requestId: 'request',
        metadata: {
          reason: '联系 +8613800138000',
          password: 'secret',
          token_hash: 'secret',
          nested: { cookie: 'secret' },
        },
      });
      const metadata = db.auditLog.create.mock.calls[0]![0].data.metadata;
      expect(JSON.stringify(metadata)).not.toContain('secret');
      expect(JSON.stringify(metadata)).not.toContain('+8613800138000');
    } catch (cause) {
      throw new Error('审计持久化秘密脱敏验证失败', { cause });
    }
  });
});
