import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const app = {
    listen: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    addHook: vi.fn(),
    log: { fatal: vi.fn(), error: vi.fn(), info: vi.fn() },
  };
  return {
    app,
    loadConfig: vi.fn(() => ({
      databaseUrl: 'postgresql://example',
      host: '127.0.0.1',
      port: 8080,
    })),
    buildApp: vi.fn(() => app),
    requireCutover: vi.fn(async () => 0n),
  };
});

vi.mock('../src/config.js', () => ({ loadConfig: mocks.loadConfig }));
vi.mock('../src/app.js', () => ({ buildApp: mocks.buildApp }));
vi.mock('../src/shutdown.js', () => ({ registerShutdown: vi.fn() }));
vi.mock('@prisma/client', () => ({ PrismaClient: class {} }));
vi.mock('../src/shared/sync-cutover.js', () => ({ requireSyncCutover: mocks.requireCutover }));

describe('服务启动错误边界', () => {
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.exitCode = undefined;
    mocks.loadConfig.mockReturnValue({
      databaseUrl: 'postgresql://example',
      host: '127.0.0.1',
      port: 8080,
    });
    mocks.app.listen.mockResolvedValue(undefined);
    mocks.app.close.mockResolvedValue(undefined);
    mocks.requireCutover.mockResolvedValue(0n);
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it('配置加载失败时输出结构化 fatal 日志并设置失败退出码', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mocks.loadConfig.mockImplementationOnce(() => {
      throw new Error('服务端配置无效：JWT_SECRET 未配置', { cause: new Error('JWT_SECRET 未配置') });
    });

    await import('../src/server.js');

    expect(process.exitCode).toBe(1);
    const record = JSON.parse(String(stderr.mock.calls[0]![0])) as {
      level: string;
      msg: string;
      err: { message: string; stack: string; cause: { message: string } };
    };
    expect(record).toMatchObject({
      level: 'fatal',
      msg: 'Sesame Notes API 启动失败',
      err: {
        message: '服务端配置无效：JWT_SECRET 未配置',
        cause: { message: 'JWT_SECRET 未配置' },
      },
    });
    expect(record.err.stack).toContain('服务端配置无效：JWT_SECRET 未配置');
    expect(mocks.buildApp).not.toHaveBeenCalled();
  });

  it('监听失败时复用应用日志并关闭已创建资源', async () => {
    const listenError = new Error('端口已被占用');
    mocks.app.listen.mockRejectedValueOnce(listenError);

    await import('../src/server.js');

    expect(mocks.app.log.fatal).toHaveBeenCalledWith({ err: listenError }, 'Sesame Notes API 启动失败');
    expect(mocks.app.close).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it('存量库未完成切换时不监听端口，并释放已装配资源', async () => {
    const failure = new Error('同步协议升级尚未完成');
    mocks.requireCutover.mockRejectedValueOnce(failure);
    await import('../src/server.js');
    expect(mocks.app.listen).not.toHaveBeenCalled();
    expect(mocks.app.log.fatal).toHaveBeenCalledWith({ err: failure }, 'Sesame Notes API 启动失败');
    expect(mocks.app.close).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it('已确认的新库水位在监听前验证通过，正常启动不误报失败', async () => {
    await import('../src/server.js');
    expect(mocks.requireCutover).toHaveBeenCalledOnce();
    expect(mocks.app.listen).toHaveBeenCalledOnce();
    expect(mocks.requireCutover.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.app.listen.mock.invocationCallOrder[0]!,
    );
    expect(mocks.app.log.fatal).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});
