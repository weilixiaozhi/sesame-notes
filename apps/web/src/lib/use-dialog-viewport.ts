import { useEffect, useState, type CSSProperties } from 'react';

const mobileDialogQuery = '(max-width: 760px)';
type DialogViewportStyle = CSSProperties & {
  '--dialog-viewport-top': string;
  '--dialog-viewport-height': string;
};

/** 与移动布局断点保持一致，不支持媒体查询时使用浏览器当前宽度。 */
export function isMobileDialogViewport(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    return typeof window.matchMedia === 'function'
      ? window.matchMedia(mobileDialogQuery).matches
      : window.innerWidth <= 760;
  } catch (error) {
    console.error('读取弹窗显示范围失败，使用默认焦点行为', error);
    return false;
  }
}

/** 跟随手机键盘与地址栏变化，只调整当前弹窗，嵌套弹窗各自清理自己的监听。 */
export function useDialogViewport(enabled: boolean): DialogViewportStyle | undefined {
  const [style, setStyle] = useState<DialogViewportStyle>();

  useEffect(() => {
    if (!enabled) return;
    let viewport: VisualViewport | null = null;
    let query: MediaQueryList | null = null;

    /** 使用可见区域尺寸放置弹窗，缺少相关能力时保留 CSS 的动态视口布局。 */
    function updateViewport(): void {
      try {
        if (!isMobileDialogViewport()) {
          setStyle(undefined);
          return;
        }
        const height = viewport?.height ?? window.innerHeight;
        const top = viewport?.offsetTop ?? 0;
        if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(top)) {
          throw new Error('浏览器返回了无效的可见区域尺寸');
        }
        const next: DialogViewportStyle = {
          '--dialog-viewport-top': `${Math.max(0, top)}px`,
          '--dialog-viewport-height': `${height}px`,
        };
        // 键盘动画可能连续触发相同尺寸，仅在实际变化时更新弹窗布局。
        setStyle((current) =>
          current?.['--dialog-viewport-top'] === next['--dialog-viewport-top'] &&
          current?.['--dialog-viewport-height'] === next['--dialog-viewport-height']
            ? current
            : next,
        );
      } catch (error) {
        console.error('更新手机弹窗可见区域失败，使用默认布局', {
          height: viewport?.height,
          offsetTop: viewport?.offsetTop,
          error,
        });
        setStyle(undefined);
      }
    }

    try {
      viewport = window.visualViewport;
      query = typeof window.matchMedia === 'function' ? window.matchMedia(mobileDialogQuery) : null;
      updateViewport();
      window.addEventListener('resize', updateViewport);
      query?.addEventListener('change', updateViewport);
      viewport?.addEventListener('resize', updateViewport);
      viewport?.addEventListener('scroll', updateViewport);
    } catch (error) {
      console.error('监听手机弹窗可见区域失败，使用默认布局', error);
      setStyle(undefined);
    }

    return () => {
      try {
        window.removeEventListener('resize', updateViewport);
        query?.removeEventListener('change', updateViewport);
        viewport?.removeEventListener('resize', updateViewport);
        viewport?.removeEventListener('scroll', updateViewport);
      } catch (error) {
        console.error('清理手机弹窗可见区域监听失败', error);
      }
    };
  }, [enabled]);

  return enabled ? style : undefined;
}
