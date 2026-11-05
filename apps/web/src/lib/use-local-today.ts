import { useEffect, useState } from 'react';
import { localDateKey } from './local-date';

/** 每半分钟及窗口恢复焦点时刷新本地今天，组件销毁时释放定时器和监听。 */
export function useLocalToday(): string {
  const [today, setToday] = useState(() => localDateKey());
  useEffect(() => {
    /** 重新读取本地时钟，同时覆盖跨午夜、系统时区调整和后台恢复。 */
    function update(): void {
      try {
        setToday(localDateKey());
      } catch (error) {
        console.error('本地日期刷新失败', error);
      }
    }
    const timer = window.setInterval(update, 30_000);
    window.addEventListener('focus', update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
    };
  }, []);
  return today;
}
