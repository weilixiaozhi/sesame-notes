import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { registerShutdown } from '../src/shutdown.js';

afterEach(() => vi.useRealTimers());

/** 用独立信号源验证关闭流程，不向测试进程发送操作系统信号。 */
function fixture(close: () => Promise<void>) {
  const signals = new EventEmitter();
  const app = { close: vi.fn(close), addHook: vi.fn(), log: { info: vi.fn(), error: vi.fn() } };
  const forceExit = vi.fn();
  registerShutdown(app as unknown as FastifyInstance, {
    signals: signals as NodeJS.Process,
    forceExit,
    timeoutMs: 100,
  });
  return { signals, app, forceExit };
}

it('SIGTERM 与 SIGINT 只关闭一次，成功后清理监听器及定时器', async () => {
  vi.useFakeTimers();
  const { signals, app, forceExit } = fixture(async () => undefined);
  signals.emit('SIGTERM');
  signals.emit('SIGINT');
  await vi.runAllTimersAsync();
  expect(app.close).toHaveBeenCalledOnce();
  expect(forceExit).not.toHaveBeenCalled();
  expect(signals.listenerCount('SIGTERM')).toBe(0);
  expect(signals.listenerCount('SIGINT')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('资源关闭失败时保留错误日志并以失败状态退出', async () => {
  vi.useFakeTimers();
  const error = new Error('disconnect failed');
  const { signals, app, forceExit } = fixture(async () => {
    throw error;
  });
  signals.emit('SIGTERM');
  await vi.runAllTimersAsync();
  expect(app.log.error).toHaveBeenCalledWith({ err: error }, '服务关闭失败');
  expect(forceExit).toHaveBeenCalledWith(1);
});

it('关闭钩子执行后仍在释放资源时，第二次信号不会绕过排空流程', async () => {
  vi.useFakeTimers();
  let finish: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const { signals, app, forceExit } = fixture(async () => pending);
  signals.emit('SIGTERM');
  const hook = app.addHook.mock.calls[0]![1] as () => Promise<void>;
  await hook();
  expect(signals.listenerCount('SIGTERM')).toBe(1);
  signals.emit('SIGTERM');
  expect(app.close).toHaveBeenCalledOnce();
  finish!();
  await vi.runAllTimersAsync();
  expect(forceExit).not.toHaveBeenCalled();
  expect(signals.listenerCount('SIGTERM')).toBe(0);
});

it('排空超时不会无限挂起', async () => {
  vi.useFakeTimers();
  const { signals, forceExit } = fixture(async () => new Promise(() => {}));
  signals.emit('SIGTERM');
  await vi.advanceTimersByTimeAsync(100);
  expect(forceExit).toHaveBeenCalledWith(1);
});

it('默认排空期限允许最长快照完成并保留资源释放时间', async () => {
  vi.useFakeTimers();
  const finished = Promise.withResolvers<void>();
  const signals = new EventEmitter();
  const forceExit = vi.fn();
  const app = { close: () => finished.promise, addHook: vi.fn(), log: { info: vi.fn(), error: vi.fn() } };
  registerShutdown(app as unknown as FastifyInstance, { signals: signals as NodeJS.Process, forceExit });
  signals.emit('SIGTERM');
  await vi.advanceTimersByTimeAsync(70_000);
  expect(forceExit).not.toHaveBeenCalled();
  finished.resolve();
  await vi.runAllTimersAsync();
  expect(forceExit).not.toHaveBeenCalled();
  expect(signals.listenerCount('SIGTERM')).toBe(0);
});
