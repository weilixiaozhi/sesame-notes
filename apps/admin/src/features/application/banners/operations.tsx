import { useRef, useState } from 'react';
import { api, errorMessage, reportError, request } from '../../../api/client';
import { queryClient } from '../../../auth/session';
import { Button, Modal } from '../../../components/ui';
import { bannerSlots, bannerTargetLabel, type BannerEntry, type BannerSlot } from './model';

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
    <Modal title="删除图片" onClose={onClose} busy={busy}>
      <div className="form-stack">
        <strong>
          {bannerSlots[current.slot].title} · {bannerTargetLabel(current)}
        </strong>
        <p>删除后此图不再参与轮播。该位置没有其他自定义图片时，应用会使用内置默认图片与入口。历史统计保留。</p>
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

/** 恢复整个位置的内置内容，使用完整快照保护其他管理员的新增和修改。 */
export function BannerReset({
  initialSlot,
  entries,
  onClose,
}: {
  initialSlot: BannerSlot;
  entries: BannerEntry[];
  onClose: () => void;
}) {
  const [slot, setSlot] = useState(initialSlot);
  const [snapshot] = useState(entries);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const rows = snapshot.filter((entry) => entry.slot === slot && entry.source === 'remote');
  /** 同一位置全部图片在一个事务中撤销，应用刷新后图片与默认跳转一起恢复。 */
  async function submit() {
    if (lock.current || !rows.length) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await request(
        () =>
          api.adminBanners.reset(slot, { revisions: rows.map((entry) => ({ id: entry.id, version: entry.version })) }),
        'banner-reset',
      );
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
    <Modal title="恢复默认" onClose={onClose} busy={busy}>
      <div className="form-stack">
        <label className="field">
          展示位置
          <select
            disabled={busy}
            value={slot}
            onChange={(event) => {
              setSlot(event.target.value as BannerSlot);
              setError('');
            }}
          >
            {Object.entries(bannerSlots).map(([value, entry]) => (
              <option value={value} key={value}>
                {entry.title}
              </option>
            ))}
          </select>
        </label>
        <p>
          {rows.length
            ? `将撤销该位置的 ${
                rows.length
              } 张自定义图片和跳转。应用下次刷新配置后使用内置默认图片与入口，历史统计保留。`
            : '该位置当前已使用内置默认图片与入口。'}
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" disabled={busy || !rows.length} onClick={() => void submit()}>
            {busy ? '正在恢复…' : '确认恢复'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
