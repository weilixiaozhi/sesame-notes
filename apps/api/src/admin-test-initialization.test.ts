import type { Prisma, PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ADMIN_GROUP_ID, verifyAdminPassword } from './modules/admin/index.js';
import { assertTestBootstrapEnvironment, initializeTestAdmin } from './admin-test-initialization.js';

type StoredAccount = {
  id: string;
  username: string;
  passwordHash: string;
  identityType: string;
  groupId: string;
  isEnabled: boolean;
  deletedAt: Date | null;
};
type DefaultGroup = { id: string; name: string; isEnabled: boolean; deletedAt: Date | null };

/** 仓储只替代数据库，事务快照用于验证失败回滚；密码计算和审计实现保持真实。 */
function repository(
  accounts: StoredAccount[] = [],
  group: DefaultGroup | null = { id: DEFAULT_ADMIN_GROUP_ID, name: '默认分组', isEnabled: true, deletedAt: null },
) {
  const state = { accounts: structuredClone(accounts), audits: [] as unknown[] };
  const sequence: string[] = [];
  const db = {
    adminAccount: {
      count: vi.fn(async () => {
        sequence.push('count');
        return state.accounts.length;
      }),
      create: vi.fn(async ({ data }: { data: Prisma.AdminAccountUncheckedCreateInput }) => {
        const row = { ...data, id: '10000000-0000-4000-8000-000000000001', deletedAt: null } as StoredAccount;
        state.accounts.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        state.accounts.find((row) => row.id === where.id),
      ),
      update: vi.fn(),
    },
    adminGroup: { findUnique: vi.fn().mockResolvedValue(group), update: vi.fn() },
    auditLog: {
      create: vi.fn(async (row: unknown) => {
        state.audits.push(row);
        return row;
      }),
    },
    user: { count: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    $queryRaw: vi.fn(async () => {
      sequence.push('lock');
      return [{ locked: '' }];
    }),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (operation: (tx: typeof db) => Promise<unknown>) => {
    const snapshot = structuredClone(state);
    try {
      return await operation(db);
    } catch (error) {
      state.accounts = snapshot.accounts;
      state.audits = snapshot.audits;
      throw error;
    }
  });
  return { db, prisma: db as unknown as PrismaClient, state, sequence };
}

/** 已存在账号使用可区别的状态，防止初始化意外覆盖用户资料。 */
function existingAccount(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id: '10000000-0000-4000-8000-000000000002',
    username: 'acceptance_admin',
    passwordHash: 'existing-password-hash',
    identityType: 'standard_user',
    groupId: 'a0000000-0000-4000-8000-000000000001',
    isEnabled: false,
    deletedAt: null,
    ...overrides,
  };
}

describe('测试默认后台用户初始化', () => {
  it('空库创建独立默认超管，使用真实密码哈希和事务审计，重复执行跳过', async () => {
    const { db, prisma, state, sequence } = repository();
    expect(await initializeTestAdmin(prisma)).toEqual({ created: true, username: 'superadmin' });
    expect(sequence).toEqual(['lock', 'count']);
    expect(db.adminAccount.count).toHaveBeenCalledWith();
    expect(state.accounts).toHaveLength(1);
    expect(state.accounts[0]).toMatchObject({
      username: 'superadmin',
      displayName: '系统管理员',
      identityType: 'super_admin',
      groupId: DEFAULT_ADMIN_GROUP_ID,
      email: null,
      phone: null,
      isEnabled: true,
    });
    expect(state.accounts[0]!.passwordHash).not.toBe('superadmin');
    expect(await verifyAdminPassword('superadmin', state.accounts[0]!.passwordHash)).toBe(true);
    expect(state.audits).toEqual([
      {
        data: expect.objectContaining({
          actor: 'system',
          action: 'admin.bootstrap',
          target: { type: 'admin_account', id: state.accounts[0]!.id },
          metadata: expect.objectContaining({ target_display: 'superadmin', identity_type: 'super_admin' }),
        }),
      },
    ]);
    const before = structuredClone(state);
    expect(await initializeTestAdmin(prisma)).toEqual({ created: false, reason: 'admin_accounts_not_empty' });
    expect(state).toEqual(before);
    expect(db.adminAccount.create).toHaveBeenCalledOnce();
    for (const operation of Object.values(db.user)) expect(operation).not.toHaveBeenCalled();
  });

  it.each([
    { label: '其他普通账号', value: existingAccount() },
    { label: '同名停用普通账号', value: existingAccount({ username: 'superadmin' }) },
    { label: '已删除账号', value: existingAccount({ deletedAt: new Date('2026-10-01T00:00:00Z') }) },
    { label: '已有超级管理员', value: existingAccount({ identityType: 'super_admin', isEnabled: true }) },
  ])('存在$label时不创建、不更名、不改密、不恢复或提权', async ({ value }) => {
    const { db, prisma, state } = repository([value]);
    expect(await initializeTestAdmin(prisma)).toEqual({ created: false, reason: 'admin_accounts_not_empty' });
    expect(state.accounts).toEqual([value]);
    expect(state.audits).toEqual([]);
    expect(db.adminAccount.create).not.toHaveBeenCalled();
    expect(db.adminAccount.update).not.toHaveBeenCalled();
    expect(db.adminGroup.findUnique).not.toHaveBeenCalled();
    expect(db.adminGroup.update).not.toHaveBeenCalled();
    for (const operation of Object.values(db.user)) expect(operation).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { id: DEFAULT_ADMIN_GROUP_ID, name: '默认分组', isEnabled: false, deletedAt: null },
    { id: DEFAULT_ADMIN_GROUP_ID, name: '默认分组', isEnabled: true, deletedAt: new Date('2026-10-01T00:00:00Z') },
  ])('默认用户组无效时拒绝创建，不自动修改组', async (group) => {
    const { db, prisma, state } = repository([], group);
    await expect(initializeTestAdmin(prisma)).rejects.toThrow(/默认用户组.*(?:不存在|已删除|已停用)/);
    expect(state.accounts).toEqual([]);
    expect(state.audits).toEqual([]);
    expect(db.adminAccount.create).not.toHaveBeenCalled();
    expect(db.adminGroup.update).not.toHaveBeenCalled();
  });

  it('审计失败回滚账号，保留错误原因供调用入口记录日志', async () => {
    const { db, prisma, state } = repository();
    db.auditLog.create.mockRejectedValueOnce(new Error('audit-unavailable'));
    await expect(initializeTestAdmin(prisma)).rejects.toMatchObject({
      message: '审计记录写入失败',
      cause: expect.objectContaining({ message: 'audit-unavailable' }),
    });
    expect(state.accounts).toEqual([]);
    expect(state.audits).toEqual([]);
  });
});

describe('测试初始化环境边界', () => {
  it.each(['postgresql', 'postgres'])('允许显式测试环境的%s专用测试库', (protocol) => {
    expect(() =>
      assertTestBootstrapEnvironment({
        SESAME_ENV: 'test',
        DATABASE_URL: `${protocol}://tester:password@localhost:55432/sesame_notes_test?schema=public`,
      }),
    ).not.toThrow();
  });

  it.each([
    { SESAME_ENV: 'prod', DATABASE_URL: 'postgresql://tester:private@localhost:55432/sesame_notes_test' },
    { SESAME_ENV: undefined, DATABASE_URL: 'postgresql://tester:private@localhost:55432/sesame_notes_test' },
    { SESAME_ENV: 'test', DATABASE_URL: 'postgresql://tester:private@localhost:55432/sesame_notes' },
    { SESAME_ENV: 'test', DATABASE_URL: 'postgresql://tester:private@localhost:55432/sesame_notes_test_copy' },
    { SESAME_ENV: 'test', DATABASE_URL: 'postgresql://tester:private@localhost:55432/sesame_notes_test/other' },
    { SESAME_ENV: 'test', DATABASE_URL: 'postgresql://tester:private@localhost:55432/sesame_notes_test#other' },
    { SESAME_ENV: 'test', DATABASE_URL: 'https://tester:private@localhost/sesame_notes_test' },
    { SESAME_ENV: 'test', DATABASE_URL: 'not-a-url-private' },
    { SESAME_ENV: 'test', DATABASE_URL: undefined },
  ])('拒绝生产环境、其他数据库和错误连接配置：%j', (env) => {
    expect(() => assertTestBootstrapEnvironment(env)).toThrow();
    try {
      assertTestBootstrapEnvironment(env);
    } catch (error) {
      expect(String(error)).not.toContain('private');
    }
  });
});
