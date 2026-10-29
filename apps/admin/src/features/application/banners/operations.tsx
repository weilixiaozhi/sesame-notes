import { useRef, useState } from 'react';
import { api, errorMessage, reportError, request } from '../../../api/client';
import { queryClient } from '../../../auth/session';
import { Button, Modal } from '../../../components/ui';
import { bannerSlots, bannerTargetLabel, type BannerEntry } from './model';

/** 配置变化后同步刷新图片列表与当前版本统计，刷新失败交由查询错误界面处理。 */
export async function refreshBanners(): Promise<void> {
  try {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin', 'banners'] }),
      queryClient.invalidateQueries({ queryKey: ['admin', 'banner-statistics'] }),
    ]);
  } catch (error) {
    reportError('banner-refresh', error);
  }
}

/** 删除单张图片，当前位置还有其他图片时继续轮播，否则自动使用内置入口。 */
export function BannerDelete({ current, onClose }: { current: BannerEntry; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  /** 删除请求绑定当前修订，历史采集记录由服务端保留。 */
  async function submit() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await request(() => api.adminBanners.remove(current.id, { version: current.version }), 'banner-delete');
      await refreshBanners();
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal title="删除 Banner" onClose={onClose} busy={busy}>
      <div className="form-stack">
        <strong>
          {bannerSlots[current.slot].title} · {bannerTargetLabel(current)}
        </strong>
        <p>确定删除此 Banner？该位置全部删除后，应用自动显示本地默认图。</p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void submit()}>
            {busy ? '正在删除…' : '确认删除'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
