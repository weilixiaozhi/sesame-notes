import { vi } from 'vitest';
import { ProductAnalyticsCollector, type ProductAnalyticsEvent } from '../lib/product-analytics';

/** 隔离时间、存储与网络，直接检查上报事件，而不是依赖 React 渲染次数。 */
export function createAnalyticsFixture() {
  let now = Date.parse('2026-10-10T00:00:00Z');
  let visible = true;
  let online = true;
  let sequence = 0;
  const store = new Map<string, string>();
  const send = vi.fn(async (_accountId: string, _events: ProductAnalyticsEvent[], _signal: AbortSignal) => {});
  const reportError = vi.fn();
  const options = {
    storage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      keys: () => [...store.keys()],
    },
    storagePrefix: 'test',
    now: () => now,
    uuid: () => `10000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    isVisible: () => visible,
    isOnline: () => online,
    send,
    reportError,
  };
  const collector = new ProductAnalyticsCollector(options);
  return {
    collector,
    options,
    send,
    store,
    reportError,
    time: (value: number) => {
      now = value;
    },
    visibility: (value: boolean) => {
      visible = value;
    },
    online: (value: boolean) => {
      online = value;
    },
  };
}
