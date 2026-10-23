import { describe, expect, it, vi } from 'vitest';
import { performSessionOperation, SessionVerification } from './verification';

/** 创建可控请求以验证网络迟到和取消时的会话隔离。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

describe('后台会话核对的请求代隔离', () => {
  it('同代单飞，作废后新登录发起独立me请求', async () => {
    const gate = new SessionVerification<string>();
    const old = deferred<string>();
    const fresh = deferred<string>();
    let oldSignal: AbortSignal | undefined;
    const loader = vi.fn((signal: AbortSignal) => {
      oldSignal = signal;
      return old.promise;
    });
    const first = gate.run(loader);
    const duplicate = gate.run(loader);
    expect(first).toBe(duplicate);
    expect(loader).toHaveBeenCalledTimes(1);
    gate.invalidate();
    expect(oldSignal?.aborted).toBe(true);
    const second = gate.run(() => fresh.promise);
    expect(second).not.toBe(first);
    fresh.resolve('新会话');
    old.resolve('旧会话');
    expect(await second).toBe('新会话');
    expect(await first).toBeUndefined();
  });
  it('旧me迟到401丢弃，不覆盖新会话或解除新代单飞', async () => {
    const gate = new SessionVerification<string>();
    const old = deferred<string>();
    const fresh = deferred<string>();
    const first = gate.run(() => old.promise);
    gate.invalidate();
    const second = gate.run(() => fresh.promise);
    old.reject(new Error('401'));
    expect(await first).toBeUndefined();
    expect(gate.run(() => Promise.resolve('错误复用'))).toBe(second);
    fresh.resolve('新授权');
    expect(await second).toBe('新授权');
  });
  it('当前代失败交由会话层呈现，不吞掉真实异常', async () => {
    const gate = new SessionVerification<string>();
    await expect(
      gate.run(async () => {
        throw new Error('当前请求失败');
      }),
    ).rejects.toThrow('当前请求失败');
  });
  it('同步抛错不会把失败请求永久留在单飞引用中', async () => {
    const gate = new SessionVerification<string>();
    await expect(
      gate.run(() => {
        throw new Error('同步错误');
      }),
    ).rejects.toThrow('同步错误');
    await expect(gate.run(async () => '新核对')).resolves.toBe('新核对');
  });
  it('退出401头先结束会话后，迟到错误正文不能覆盖新的登录', async () => {
    const gate = new SessionVerification<string>();
    const body = deferred<void>();
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    const logout = performSessionOperation(gate, () => body.promise, onSuccess, onFailure);
    // 模拟 401 响应头先触发 end，再开始新的登录代。
    gate.invalidate();
    gate.invalidate();
    body.reject(new Error('迟到的401错误正文'));
    await logout;
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });
  it('过期登录或退出成功正文不会继续核对或结束当前会话', async () => {
    const gate = new SessionVerification<string>();
    const loginBody = deferred<string>();
    const verifyNewSession = vi.fn();
    const login = performSessionOperation(gate, () => loginBody.promise, verifyNewSession, vi.fn());
    gate.invalidate();
    loginBody.resolve('旧登录成功');
    await login;
    expect(verifyNewSession).not.toHaveBeenCalled();
    const logoutBody = deferred<void>();
    const endCurrentSession = vi.fn();
    const logout = performSessionOperation(gate, () => logoutBody.promise, endCurrentSession, vi.fn());
    gate.invalidate();
    logoutBody.resolve();
    await logout;
    expect(endCurrentSession).not.toHaveBeenCalled();
  });
  it('当前代登录失败仍交回表单，当前代退出成功仍提交', async () => {
    const gate = new SessionVerification<string>();
    const success = vi.fn();
    await performSessionOperation(gate, async () => '成功', success, vi.fn());
    expect(success).toHaveBeenCalledWith('成功');
    await expect(
      performSessionOperation(
        gate,
        async () => {
          throw new Error('当前失败');
        },
        vi.fn(),
        (error) => {
          throw error;
        },
      ),
    ).rejects.toThrow('当前失败');
  });
});
