import { useEffect, useRef } from 'react';
import {
  getProductAnalyticsCollector,
  type ProductAnalyticsPage,
  type ProductAnalyticsContext,
} from './product-analytics-runtime';

/** 子页与弹窗按实际展示计访问，重绘不重复；关闭弹窗时恢复可见的底层页面。 */
export function useProductAnalyticsPage(
  page: ProductAnalyticsPage,
  visible = true,
  priority = 2,
  context?: ProductAnalyticsContext | null,
): void {
  const key = useRef(Symbol('使用统计页面'));
  useEffect(() => {
    const surfaceKey = key.current;
    let cancelled = false;
    // 根组件先完成登录身份同步，再登记业务页面，避免首次挂载丢失账号归属。
    queueMicrotask(() => {
      try {
        if (!cancelled && visible) getProductAnalyticsCollector().showSurface(surfaceKey, page, priority, context);
      } catch (error) {
        console.warn('[使用统计] 子页面记录暂不可用', error);
      }
    });
    return () => {
      cancelled = true;
      // 卸载和新页登记进入同一微任务阶段，页签切换只结算最终可见页。
      queueMicrotask(() => {
        try {
          getProductAnalyticsCollector().hideSurface(surfaceKey);
        } catch (error) {
          console.warn('[使用统计] 页面恢复记录暂不可用', error);
        }
      });
    };
  }, [page, visible, priority, context]);
}

/** 只观察登录身份、已解析页面与前台交互，不识别业务路由或读取业务内容。 */
export function useProductAnalytics(
  accountId: string | null,
  page: ProductAnalyticsPage | undefined,
  visitKey: string,
): void {
  useEffect(() => {
    try {
      const instance = getProductAnalyticsCollector();
      instance.setAccount(accountId);
      instance.enterPage(page, visitKey);
    } catch (error) {
      console.warn('[使用统计] 页面记录暂不可用', error);
    }
  }, [accountId, page, visitKey]);

  useEffect(() => {
    /** 可见页面中的真实交互才作为活跃依据。 */
    const interact = () => {
      try {
        getProductAnalyticsCollector().interact();
      } catch (error) {
        console.warn('[使用统计] 活跃记录暂不可用', error);
      }
    };
    /** 恢复网络只发送已发生的事件，不生成新的页面访问。 */
    const online = () => {
      try {
        getProductAnalyticsCollector().schedule();
      } catch (error) {
        console.warn('[使用统计] 发送任务暂不可用', error);
      }
    };
    document.addEventListener('visibilitychange', interact);
    document.addEventListener('pointerdown', interact, { passive: true });
    document.addEventListener('keydown', interact, { passive: true });
    window.addEventListener('online', online);
    return () => {
      document.removeEventListener('visibilitychange', interact);
      document.removeEventListener('pointerdown', interact);
      document.removeEventListener('keydown', interact);
      window.removeEventListener('online', online);
    };
  }, []);
}
