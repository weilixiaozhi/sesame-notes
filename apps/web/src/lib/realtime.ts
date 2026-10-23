import { useEffect, useState } from 'react';
import { unwrap } from '@sesame-notes/api-client';
import { api, queryClient } from './session';

/** 实时消息仅触发重新查询；重连和窗口回焦也读取权威数据。 */
export function useRealtime(accountId: string) {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let connection = 0;
    let pending: AbortController | undefined;
    const invalidate = () => {
      if (refresh) clearTimeout(refresh);
      refresh = setTimeout(() => {
        if (!disposed) void queryClient.invalidateQueries({ queryKey: ['account', accountId] });
      }, 150);
    };
    /** 重连总是重新获取一次性票据。 */
    async function connect() {
      if (disposed || !navigator.onLine) return;
      const current = ++connection;
      pending?.abort();
      const abort = new AbortController();
      pending = abort;
      try {
        const { ticket } = unwrap(await api.POST('/api/v1/ws/ticket', { signal: abort.signal }));
        if (disposed || current !== connection || !navigator.onLine) return;
        const url = new URL('/api/v1/ws', window.location.origin);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('ticket', ticket);
        const currentSocket = new WebSocket(url);
        let readyReceived = false;
        socket = currentSocket;
        currentSocket.onopen = () => {
          if (disposed || current !== connection) {
            currentSocket.close();
          }
        };
        currentSocket.onmessage = (event: MessageEvent<string>) => {
          if (disposed || current !== connection) return;
          try {
            const message: unknown = JSON.parse(event.data);
            if (message && typeof message === 'object' && 'type' in message) {
              if (message.type === 'ready' && !readyReceived) {
                // TCP 建连早于服务端授权/订阅完成，只有 ready 后补拉才能覆盖该窗口内的写入。
                readyReceived = true;
                attempt = 0;
                invalidate();
              } else if (message.type === 'sync_change') invalidate();
            }
          } catch {
            /* 不可信通知不作为业务状态，忽略无效消息。 */
          }
        };
        currentSocket.onerror = () => currentSocket.close();
        currentSocket.onclose = () => {
          if (disposed || current !== connection) return;
          schedule(current);
        };
      } catch {
        if (disposed || current !== connection) return;
        schedule(current);
      }
    }
    /** 对不可用网络采用有上限的指数退避。 */
    function schedule(current: number) {
      if (disposed || current !== connection || !navigator.onLine) return;
      if (retry) clearTimeout(retry);
      retry = setTimeout(() => void connect(), Math.min(30_000, 1000 * 2 ** attempt++));
    }
    /** 断网或切换账号使旧票据与旧 socket 回调同时失效，避免迟到事件关闭新连接。 */
    function stopConnection() {
      connection++;
      pending?.abort();
      if (retry) clearTimeout(retry);
      socket?.close();
      socket = undefined;
    }
    const onOnline = () => {
      setOnline(true);
      invalidate();
      stopConnection();
      void connect();
    };
    const onOffline = () => {
      setOnline(false);
      stopConnection();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    void connect();
    return () => {
      disposed = true;
      stopConnection();
      if (refresh) clearTimeout(refresh);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [accountId]);
  return { online };
}
