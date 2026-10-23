import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRealtime } from './realtime';

const mocks = vi.hoisted(() => ({ post: vi.fn(), invalidate: vi.fn() }));
vi.mock('./session', () => ({ api: { POST: mocks.post }, queryClient: { invalidateQueries: mocks.invalidate } }));

/** 可控的浏览器传输用于重现断网后旧 socket 迟到回调。 */
class TestSocket {
  static instances: TestSocket[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: MessageEvent<string>) => void;
  close = vi.fn(() => this.onclose?.());
  constructor(public url: URL) {
    TestSocket.instances.push(this);
  }
  emit(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent<string>);
  }
}
const ticket = () => ({ data: { ticket: 'one-use-ticket' }, response: new Response(null, { status: 200 }) });
let online = true;
beforeEach(() => {
  vi.useFakeTimers();
  online = true;
  TestSocket.instances = [];
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
  vi.stubGlobal('WebSocket', TestSocket);
  mocks.post.mockReset().mockResolvedValue(ticket());
  mocks.invalidate.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('实时变更提示', () => {
  it('首次与重连均等待订阅 ready 后补拉，同连接握手去重', async () => {
    renderHook(() => useRealtime('A'));
    await act(async () => {});
    const first = TestSocket.instances[0]!;
    act(() => first.onopen?.());
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(mocks.invalidate).not.toHaveBeenCalled();
    act(() => first.emit({ type: 'ready' }));
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    act(() => first.emit({ type: 'ready' }));
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    act(() => first.onclose?.());
    await act(() => vi.advanceTimersByTimeAsync(1000));
    const second = TestSocket.instances[1]!;
    act(() => second.onopen?.());
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    act(() => second.emit({ type: 'ready' }));
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(mocks.invalidate).toHaveBeenCalledTimes(2);
  });
  it('只将提示合并为权威查询刷新，不将通知内容写进缓存', async () => {
    renderHook(() => useRealtime('A'));
    await act(async () => {});
    const socket = TestSocket.instances[0]!;
    act(() => socket.onopen?.());
    await act(() => vi.advanceTimersByTimeAsync(150));
    mocks.invalidate.mockClear();
    act(() => {
      socket.emit({ type: 'ready' });
      socket.onmessage?.({ data: 'invalid' } as MessageEvent<string>);
    });
    expect(mocks.invalidate).not.toHaveBeenCalled();
    act(() => {
      socket.emit({ type: 'sync_change', payload: 'not-authoritative' });
      socket.emit({ type: 'sync_change' });
    });
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ['account', 'A'] });
  });

  it('恢复网络后忽略旧 socket 的错误、关闭与消息，不干扰新连接', async () => {
    const hook = renderHook(() => useRealtime('A'));
    await act(async () => {});
    const old = TestSocket.instances[0]!;
    act(() => {
      old.onopen?.();
      online = false;
      window.dispatchEvent(new Event('offline'));
    });
    expect(hook.result.current.online).toBe(false);
    act(() => {
      online = true;
      window.dispatchEvent(new Event('online'));
    });
    await act(async () => {});
    const current = TestSocket.instances[1]!;
    act(() => current.onopen?.());
    await act(() => vi.advanceTimersByTimeAsync(150));
    mocks.invalidate.mockClear();
    act(() => {
      old.onerror?.();
      old.onclose?.();
      old.emit({ type: 'sync_change' });
    });
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(current.close).not.toHaveBeenCalled();
    expect(TestSocket.instances).toHaveLength(2);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('断网时丢弃尚未完成的票据，卸载后不重连', async () => {
    let finish!: (value: ReturnType<typeof ticket>) => void;
    mocks.post.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const hook = renderHook(() => useRealtime('A'));
    act(() => {
      online = false;
      window.dispatchEvent(new Event('offline'));
    });
    await act(async () => finish(ticket()));
    expect(TestSocket.instances).toHaveLength(0);
    act(() => {
      online = true;
      window.dispatchEvent(new Event('online'));
    });
    await act(async () => {});
    expect(TestSocket.instances).toHaveLength(1);
    hook.unmount();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });
});
