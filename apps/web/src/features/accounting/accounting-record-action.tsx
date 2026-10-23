import { cloneElement, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Plus } from 'lucide-react';
import { Button } from '../../components/ui';
import './accounting-record-action.css';

const mobileViewport = '(max-width: 760px)';

/** 服务端与不支持媒体查询的环境使用页面内按钮，浏览器按底栏断点读取布局。 */
function isMobileViewport(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(mobileViewport).matches
      : false;
  } catch (error) {
    console.error('读取记账入口显示范围失败', error);
    return false;
  }
}

/** 旋转或窗口变化时通知 React 更新唯一入口，卸载后取消原始监听。 */
function subscribeViewport(onChange: () => void): () => void {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
    const query = window.matchMedia(mobileViewport);
    query.addEventListener('change', onChange);
    return () => {
      try {
        query.removeEventListener('change', onChange);
      } catch (error) {
        console.error('清理记账入口窗口监听失败', error);
      }
    };
  } catch (error) {
    console.error('监听记账入口窗口变化失败', error);
    return () => undefined;
  }
}

/** 手机把主操作挂到页面根部，绕过查询容器的固定定位边界；桌面保留记录区入口。 */
export function AccountingRecordAction({ disabled, onCreate }: { disabled: boolean; onCreate: () => void }) {
  const mobile = useSyncExternalStore(subscribeViewport, isMobileViewport, () => false);
  if (mobile && disabled) return null;
  const button = (
    <Button
      className={mobile ? 'accounting-floating-record-action' : 'accounting-record-action'}
      disabled={disabled}
      onClick={onCreate}
    >
      <Plus size={18} aria-hidden="true" />
      记一笔
    </Button>
  );
  if (!mobile) return button;
  try {
    return createPortal(button, document.body);
  } catch (error) {
    console.error('显示固定记账入口失败，已保留页面内入口', error);
    return cloneElement(button, { className: 'accounting-record-action' });
  }
}
