import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ construct: vi.fn(), deleteAccount: vi.fn(), disconnect: vi.fn() }));
vi.mock('@prisma/client', () => ({
  PrismaClient: class {
    constructor() {
      mocks.construct();
    }
    $disconnect = mocks.disconnect;
  },
}));
vi.mock('../src/modules/accounts/index.js', () => ({ deleteAccount: mocks.deleteAccount }));
const userId = '11111111-1111-4111-8111-111111111111';
const originalExit = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.exitCode = undefined;
  vi.stubEnv('DELETE_ACCOUNT_ID', userId);
  vi.stubEnv('DELETE_ACCOUNT_CONFIRM', userId);
  vi.stubEnv('DATABASE_URL', 'postgresql://unused:unused@localhost:1/unused');
  mocks.deleteAccount.mockResolvedValue({ deleted: false, detachedMembers: 0 });
  mocks.disconnect.mockResolvedValue(undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  process.exitCode = originalExit;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each(['DELETE_ACCOUNT_ID', 'DELETE_ACCOUNT_CONFIRM', 'DATABASE_URL'])(
  '缺少%s时不创建连接、不执行删除',
  async (key) => {
    vi.stubEnv(key, undefined);
    await import('../src/account-delete.js');
    expect(process.exitCode).toBe(1);
    expect(mocks.construct).not.toHaveBeenCalled();
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  },
);

it('确认值必须精确匹配账号，合法输入调用受控用例并断开连接', async () => {
  vi.stubEnv('DELETE_ACCOUNT_CONFIRM', 'DELETE');
  await import('../src/account-delete.js');
  expect(mocks.deleteAccount).not.toHaveBeenCalled();
  vi.resetModules();
  process.exitCode = undefined;
  vi.stubEnv('DELETE_ACCOUNT_CONFIRM', userId);
  await import('../src/account-delete.js');
  expect(mocks.deleteAccount).toHaveBeenCalledWith(expect.anything(), userId);
  expect(mocks.disconnect).toHaveBeenCalledOnce();
  expect(process.exitCode).toBeUndefined();
});
