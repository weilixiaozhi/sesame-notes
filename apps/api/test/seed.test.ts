import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PASSWORD = 'Tb9!rC4@xN7#qS2$hV8%mK6';
const DEFAULT_GROUP_ID = 'a0000000-0000-4000-8000-000000000000';
const GROUP_ID = 'a0000000-0000-4000-8000-000000000001';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findGroup: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  revokeSessions: vi.fn(),
  audit: vi.fn(),
  lock: vi.fn(),
  transaction: vi.fn(),
  userFind: vi.fn(),
  userCreate: vi.fn(),
  userUpdate: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('@prisma/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  PrismaClient: class {
    adminAccount = {
      findUnique: mocks.findUnique,
      count: mocks.count,
      create: mocks.create,
      update: mocks.update,
    };
    adminGroup = { findUnique: mocks.findGroup };
    adminSession = { updateMany: mocks.revokeSessions };
    auditLog = { create: mocks.audit };
    user = { findUnique: mocks.userFind, create: mocks.userCreate, update: mocks.userUpdate };
    $queryRaw = mocks.lock;
    $transaction = (fn: (tx: this) => Promise<unknown>) => mocks.transaction(fn, this);
    $disconnect = mocks.disconnect;
  },
}));

const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.exitCode = undefined;
  for (const key of [
    'SEED_ADMIN_EMAIL',
    'SEED_ADMIN_PHONE',
    'SEED_ADMIN_COUNTRY_CODE',
    'ADMIN_RECOVERY_CONFIRM',
    'ADMIN_USERNAME',
    'ADMIN_PASSWORD',
  ]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv('SEED_CONFIRM', 'CREATE_ADMIN');
  vi.stubEnv('SEED_ADMIN_USERNAME', 'Seed_Root');
  vi.stubEnv('SEED_ADMIN_PASSWORD', PASSWORD);
  vi.stubEnv('SEED_ADMIN_GROUP_ID', undefined);
  mocks.findGroup.mockResolvedValue({ id: DEFAULT_GROUP_ID, deletedAt: null, isEnabled: true });
  let createdAccount: { id: string; username: string } | null = null;
  // 审计按已创建账号的主键读取用户名，其他未创建账号仍不存在。
  mocks.findUnique.mockImplementation(async ({ where }) =>
    createdAccount && where.id === createdAccount.id ? createdAccount : null,
  );
  mocks.count.mockResolvedValue(0);
  mocks.create.mockImplementation(async ({ data }) => {
    createdAccount = { id: ADMIN_ID, username: data.username };
    return createdAccount;
  });
  mocks.update.mockResolvedValue({ id: ADMIN_ID });
  mocks.revokeSessions.mockResolvedValue({ count: 2 });
  mocks.audit.mockResolvedValue({ id: 1n });
  mocks.lock.mockResolvedValue([{ locked: '' }]);
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>, tx: unknown) => await fn(tx));
  mocks.disconnect.mockResolvedValue(undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  expect(mocks.userFind).not.toHaveBeenCalled();
  expect(mocks.userCreate).not.toHaveBeenCalled();
  expect(mocks.userUpdate).not.toHaveBeenCalled();
  const output = [...vi.mocked(process.stdout.write).mock.calls, ...vi.mocked(process.stderr.write).mock.calls]
    .map((call) => String(call[0]))
    .join('');
  expect(output).not.toContain(PASSWORD);
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('独立管理员引导入口', () => {
  it.each([
    ['SEED_CONFIRM', undefined],
    ['SEED_CONFIRM', 'CREATE'],
    ['SEED_ADMIN_GROUP_ID', 'not-a-group'],
    ['SEED_ADMIN_USERNAME', undefined],
    ['SEED_ADMIN_USERNAME', '   '],
    ['SEED_ADMIN_USERNAME', '13900000000'],
    ['SEED_ADMIN_USERNAME', 'abc'],
    ['SEED_ADMIN_USERNAME', 'root administrator'],
    ['SEED_ADMIN_EMAIL', 'not-an-email'],
    ['SEED_ADMIN_PHONE', 'not-a-phone'],
    ['SEED_ADMIN_COUNTRY_CODE', '+86'],
    ['SEED_ADMIN_PASSWORD', undefined],
    ['SEED_ADMIN_PASSWORD', ''],
  ])('拒绝 %s=%s 且不读写数据库', async (key, value) => {
    vi.stubEnv(key!, value);
    await import('../src/admin-bootstrap.js');
    expect(process.exitCode).toBe(1);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  it.each(['x', '   ', 'passwordpassword', 'seed_root', '密'.repeat(513)])(
    '初始化保留任意非空密码的全部字符：%j',
    async (password) => {
      vi.stubEnv('SEED_ADMIN_PASSWORD', password);
      await import('../src/admin-bootstrap.js');
      expect(process.exitCode).toBeUndefined();
      const { verifyAdminPassword } = await import('../src/modules/admin/index.js');
      expect(await verifyAdminPassword(password, mocks.create.mock.calls[0]![0].data.passwordHash)).toBe(true);
    },
  );

  it('生产环境首次创建独立超级管理员，密码真实散列且可直接正常登录', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await import('../src/admin-bootstrap.js');
    expect(process.exitCode).toBeUndefined();
    expect(mocks.lock).toHaveBeenCalledOnce();
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { username: 'seed_root' } });
    expect(mocks.count).toHaveBeenCalledWith({ where: { identityType: 'super_admin' } });
    const data = mocks.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      username: 'seed_root',
      email: null,
      phone: null,
      identityType: 'super_admin',
      groupId: DEFAULT_GROUP_ID,
      isEnabled: true,
    });
    expect(mocks.findGroup).toHaveBeenCalledWith({ where: { id: DEFAULT_GROUP_ID } });
    expect(data).not.toHaveProperty('phoneE164');
    expect(data).not.toHaveProperty('isAdmin');
    expect(data.passwordHash).not.toBe(PASSWORD);
    const { verifyAdminPassword } = await import('../src/modules/admin/index.js');
    expect(await verifyAdminPassword(PASSWORD, data.passwordHash)).toBe(true);
    expect(mocks.audit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actor: 'system',
        action: 'admin.bootstrap',
        target: { type: 'admin_account', id: ADMIN_ID },
        metadata: expect.objectContaining({ target_display: 'seed_root' }),
      }),
    });
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  it.each([undefined, '', '   \t\n'])('初始化组参数为空时归入系统默认组：%j', async (value) => {
    vi.stubEnv('SEED_ADMIN_GROUP_ID', value);
    await import('../src/admin-bootstrap.js');
    expect(process.exitCode).toBeUndefined();
    expect(mocks.findGroup).toHaveBeenCalledWith({ where: { id: DEFAULT_GROUP_ID } });
    expect(mocks.create.mock.calls[0]![0].data).toMatchObject({
      identityType: 'super_admin',
      groupId: DEFAULT_GROUP_ID,
    });
  });

  it('初始化可选联系方式归一化且作为同一后台账号的登录标识保存', async () => {
    vi.stubEnv('SEED_ADMIN_EMAIL', ' Staff+Test@Example.com ');
    vi.stubEnv('SEED_ADMIN_PHONE', '138 0013 8000');
    await import('../src/admin-bootstrap.js');
    expect(process.exitCode).toBeUndefined();
    expect(mocks.create.mock.calls[0]![0].data).toMatchObject({
      username: 'seed_root',
      email: 'staff+test@example.com',
      phone: '+8613800138000',
    });
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { email: 'staff+test@example.com' }, select: { id: true } });
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { phone: '+8613800138000' }, select: { id: true } });
  });

  it('可选联系方式留空时按未填写保存', async () => {
    vi.stubEnv('SEED_ADMIN_EMAIL', '   ');
    vi.stubEnv('SEED_ADMIN_PHONE', '');
    await import('../src/admin-bootstrap.js');
    expect(process.exitCode).toBeUndefined();
    expect(mocks.create.mock.calls[0]![0].data).toMatchObject({ email: null, phone: null });
  });

  it.each([
    ['SEED_ADMIN_EMAIL', 'staff@example.com', 'email'],
    ['SEED_ADMIN_PHONE', '13800138000', 'phone'],
  ])('初始化拒绝已被其他后台账号使用的 %s', async (key, value, field) => {
    vi.stubEnv(key!, value);
    mocks.findUnique.mockImplementation(async ({ where }) =>
      where[field!] === undefined ? null : { id: 'another-admin-account' },
    );
    await import('../src/admin-bootstrap.js');
    expect(process.exitCode).toBe(1);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each(['super_admin', 'standard_user'])(
    '同名 %s 重复引导是幂等操作，不修改密码、状态或提权',
    async (identityType) => {
      mocks.findUnique.mockResolvedValue({
        id: ADMIN_ID,
        identityType,
        isEnabled: false,
        passwordHash: 'existing-hash',
      });
      vi.stubEnv('SEED_ADMIN_GROUP_ID', GROUP_ID);
      mocks.findGroup.mockResolvedValue({ id: GROUP_ID, deletedAt: null, isEnabled: false });
      await import('../src/admin-bootstrap.js');
      expect(process.exitCode).toBeUndefined();
      expect(mocks.findGroup).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.revokeSessions).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
      expect(mocks.disconnect).toHaveBeenCalledOnce();
    },
  );

  it.each(['missing', 'deleted', 'disabled'] as const)('所选组 %s 时拒绝初始化且不写入账号或日志', async (state) => {
    vi.stubEnv('SEED_ADMIN_GROUP_ID', GROUP_ID);
    mocks.findGroup.mockResolvedValue(
      state === 'missing'
        ? null
        : { id: GROUP_ID, deletedAt: state === 'deleted' ? new Date() : null, isEnabled: state !== 'disabled' },
    );
    await import('../src/admin-bootstrap.js');
    expect(process.exitCode).toBe(1);
    expect(mocks.findGroup).toHaveBeenCalledWith({ where: { id: GROUP_ID } });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.revokeSessions).not.toHaveBeenCalled();
    if (state === 'disabled') {
      expect(
        vi
          .mocked(process.stderr.write)
          .mock.calls.map((call) => String(call[0]))
          .join(''),
      ).toContain('所选用户组已停用');
    }
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  it('显式选择可用组时验证并保存所选归属', async () => {
    vi.stubEnv('SEED_ADMIN_GROUP_ID', `  ${GROUP_ID}\t`);
    mocks.findGroup.mockResolvedValue({ id: GROUP_ID, deletedAt: null, isEnabled: true });
    await import('../src/admin-bootstrap.js');
    expect(process.exitCode).toBeUndefined();
    expect(mocks.findGroup).toHaveBeenCalledWith({ where: { id: GROUP_ID } });
    expect(mocks.create.mock.calls[0]![0].data).toMatchObject({ identityType: 'super_admin', groupId: GROUP_ID });
  });

  it('已有其他超级管理员时拒绝再次引导，计数包含已禁用账号', async () => {
    mocks.count.mockResolvedValue(1);
    await import('../src/admin-bootstrap.js');
    expect(process.exitCode).toBe(1);
    expect(mocks.count).toHaveBeenCalledWith({ where: { identityType: 'super_admin' } });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  it('存储故障以失败退出，不能改用旧用户账号引导', async () => {
    mocks.findUnique.mockRejectedValue(new Error('test admin store unavailable'));
    await import('../src/admin-bootstrap.js');
    expect(process.exitCode).toBe(1);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });
});

describe('受控管理员密码恢复', () => {
  beforeEach(() => {
    vi.stubEnv('ADMIN_RECOVERY_CONFIRM', 'RESET_ADMIN_PASSWORD');
    vi.stubEnv('ADMIN_USERNAME', 'Recovery_Admin');
    vi.stubEnv('ADMIN_PASSWORD', PASSWORD);
    mocks.findUnique.mockResolvedValue({
      id: ADMIN_ID,
      username: 'recovery_admin',
      identityType: 'standard_user',
      isEnabled: true,
      deletedAt: null,
    });
  });

  it.each([
    ['ADMIN_RECOVERY_CONFIRM', undefined],
    ['ADMIN_RECOVERY_CONFIRM', 'RESET'],
    ['ADMIN_USERNAME', undefined],
    ['ADMIN_USERNAME', '13900000000'],
    ['ADMIN_PASSWORD', undefined],
    ['ADMIN_PASSWORD', ''],
  ])('拒绝 %s=%s 且不读写数据库', async (key, value) => {
    vi.stubEnv(key!, value);
    await import('../src/admin-recover.js');
    expect(process.exitCode).toBe(1);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.revokeSessions).not.toHaveBeenCalled();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  it.each(['x', '   ', 'passwordpassword', 'recovery_admin', '密'.repeat(513)])(
    '恢复密码保留任意非空输入并撤销旧会话：%j',
    async (password) => {
      vi.stubEnv('ADMIN_PASSWORD', password);
      await import('../src/admin-recover.js');
      expect(process.exitCode).toBeUndefined();
      const { verifyAdminPassword } = await import('../src/modules/admin/index.js');
      expect(await verifyAdminPassword(password, mocks.update.mock.calls[0]![0].data.passwordHash)).toBe(true);
      expect(mocks.revokeSessions).toHaveBeenCalledOnce();
    },
  );

  it.each(['missing', 'disabled', 'deleted'])('%s 管理员不能被恢复命令创建或自动启用', async (state) => {
    mocks.findUnique.mockResolvedValue(
      state === 'missing'
        ? null
        : { id: ADMIN_ID, isEnabled: state === 'deleted', deletedAt: state === 'deleted' ? new Date() : null },
    );
    await import('../src/admin-recover.js');
    expect(process.exitCode).toBe(1);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.revokeSessions).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  it('只重置现有账号密码、解锁登录并撤销旧会话，身份、组与启用状态不变', async () => {
    await import('../src/admin-recover.js');
    expect(process.exitCode).toBeUndefined();
    expect(mocks.lock).toHaveBeenCalledOnce();
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { username: 'recovery_admin' } });
    expect(mocks.create).not.toHaveBeenCalled();
    const update = mocks.update.mock.calls[0]![0];
    expect(update).toEqual({
      where: { id: ADMIN_ID },
      data: {
        passwordHash: expect.any(String),
        failedLoginAttempts: 0,
        lockedUntil: null,
        version: { increment: 1 },
        updatedBy: '系统恢复',
      },
    });
    const { verifyAdminPassword } = await import('../src/modules/admin/index.js');
    expect(await verifyAdminPassword(PASSWORD, update.data.passwordHash)).toBe(true);
    expect(mocks.revokeSessions).toHaveBeenCalledWith({
      where: { adminId: ADMIN_ID, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(mocks.audit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actor: 'system',
        action: 'admin.password_recovered',
        target: { type: 'admin_account', id: ADMIN_ID },
        metadata: expect.objectContaining({ target_display: 'recovery_admin' }),
      }),
    });
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });
});
