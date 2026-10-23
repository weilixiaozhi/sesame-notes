import { unwrap } from '@sesame-notes/api-client';
import { captureSessionOperation } from './session';
import {
  ProductAnalyticsCollector,
  type ProductAnalyticsAction,
  type ProductAnalyticsPage,
  type ProductAnalyticsContext,
} from './product-analytics';
export type { ProductAnalyticsContext, ProductAnalyticsPage } from './product-analytics';

let collector: ProductAnalyticsCollector | null = null;

/** 事件按账号与 UUID 独立持久保存，重开页面可恢复，多个标签页重报由服务端去重。 */
export function getProductAnalyticsCollector(): ProductAnalyticsCollector {
  if (collector) return collector;
  collector = new ProductAnalyticsCollector({
    storage: {
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
      removeItem: (key) => localStorage.removeItem(key),
      keys: () =>
        Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter(
          (key): key is string => key !== null,
        ),
    },
    storagePrefix: 'sesame-product-analytics',
    now: () => Date.now(),
    uuid: () => crypto.randomUUID(),
    isVisible: () => document.visibilityState === 'visible',
    isOnline: () => navigator.onLine,
    /** 网络客户端固定捕获当前账号，并拒绝迟到事件借用另一个账号的登录凭据。 */
    send: async (accountId, events, signal) => {
      const operation = captureSessionOperation(accountId);
      const receipt = unwrap(await operation.client.POST('/api/v1/analytics/events', { body: { events }, signal }));
      // 完整确认新增和已去重事件后才允许清理队列，异常响应保持原事件供重试。
      if (
        !receipt ||
        !Number.isSafeInteger(receipt.accepted) ||
        receipt.accepted < 0 ||
        !Number.isSafeInteger(receipt.duplicates) ||
        receipt.duplicates < 0 ||
        receipt.accepted + receipt.duplicates !== events.length
      ) {
        throw new Error('统计服务未完整确认本次事件，稍后重试');
      }
    },
    reportError: (error) => console.warn('[使用统计] 发送或缓存失败，页面可继续使用', error),
  });
  return collector;
}

/** 业务边界只传固定动作和页面标识，采集失败由日志承接且不影响正常操作。 */
export function trackProductAction(
  eventName: ProductAnalyticsAction,
  page?: ProductAnalyticsPage,
  expectedAccountId?: string,
  context?: ProductAnalyticsContext | null,
): void {
  try {
    getProductAnalyticsCollector().trackAction(eventName, page, expectedAccountId, context);
  } catch (error) {
    console.warn('[使用统计] 操作记录暂不可用', error);
  }
}

/** 入口按操作生成随机流程上下文，业务记录身份和内容不参与生成。 */
export function beginProductAnalyticsFlow(): ProductAnalyticsContext | null {
  try {
    return getProductAnalyticsCollector().beginFlow();
  } catch (error) {
    console.warn('[使用统计] 流程记录暂不可用', error);
    return null;
  }
}

/** 按本次按钮交互捕获会话；异步完成沿用此不可变上下文，不借用全局当前操作。 */
export function captureProductAnalyticsContext(
  flow?: ProductAnalyticsContext | null,
  interacting = true,
): ProductAnalyticsContext | null {
  try {
    return getProductAnalyticsCollector().captureContext(flow, interacting);
  } catch (error) {
    console.warn('[使用统计] 操作关联暂不可用', error);
    return null;
  }
}
