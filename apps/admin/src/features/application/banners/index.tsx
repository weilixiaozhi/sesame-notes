import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, errorMessage, InputError, reportError, request } from '../../../api/client';
import { queryClient, useSession } from '../../../auth/session';
import { Button, Loading, Modal, RequestError, StatusBadge } from '../../../components/ui';
import { bannerImageId, bannerPreview, bannerSlots, bannerTargets, defaultBanner } from './model';
import type { BannerEntry, BannerTarget } from './model';
import './styles.css';

const queryKey = ['admin', 'banners'];

/** 固定入口独立配置，页面首次读取失败时保留重试入口。 */
export function BannersPage({ active }: { active: boolean }) {
  const session = useSession();
  const canWrite = session.session!.admin.permissions.includes('banners:write');
  const [editing, setEditing] = useState<BannerEntry>();
  const query = useQuery({
    queryKey,
    enabled: active,
    queryFn: ({ signal }) => request(() => api.adminBanners.list(signal), 'banner-list'),
  });
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Banner 管理</h1>
          <p className="muted">管理应用入口的图片和跳转页面。离线或图片不可用时，应用自动使用内置图片和默认入口。</p>
        </div>
        <Button disabled={query.isFetching} onClick={() => void query.refetch()}>
          刷新
        </Button>
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <RequestError error={query.error} retry={() => void query.refetch()} />
      ) : (
        <div className="banner-grid">
          {query.data.items.map((entry) => (
            <section className="banner-card" key={entry.slot}>
              <BannerPreview entry={entry} />
              <div className="banner-card-content">
                <div className="banner-card-heading">
                  <h2>{bannerSlots[entry.slot].title}</h2>
                  <StatusBadge enabled={entry.is_enabled} enabledLabel="自定义" disabledLabel="应用默认" />
                </div>
                <p>点击进入：{bannerTargets[entry.is_enabled ? entry.target : entry.slot]}</p>
                {canWrite && <Button onClick={() => setEditing(entry)}>配置图片与跳转</Button>}
              </div>
            </section>
          ))}
        </div>
      )}
      {editing && canWrite && <BannerEditor current={editing} onClose={() => setEditing(undefined)} />}
    </>
  );
}

/** 图片读取失败显示真实状态，避免把未生效的默认图片当作配置预览。 */
function BannerPreview({ entry }: { entry: BannerEntry }) {
  const source = bannerPreview(entry);
  const [failed, setFailed] = useState<string>();
  if (failed === source)
    return (
      <div className="banner-preview banner-preview-error" role="status">
        <span>图片暂时无法预览，请重试或更换图片。</span>
        <Button onClick={() => setFailed(undefined)}>重试预览</Button>
      </div>
    );
  return (
    <img
      className="banner-preview"
      src={source}
      alt={bannerSlots[entry.slot].title}
      onError={() => {
        reportError('banner-preview', new Error('BANNER_PREVIEW_UNAVAILABLE'));
        setFailed(source);
      }}
    />
  );
}

/** 图片在浏览器内编码后上传，不持久化到浏览器，也不写入日志。 */
async function encodeImage(file: File): Promise<string> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(binary);
  } catch (error) {
    reportError('banner-file-read', error);
    throw new InputError('图片读取失败，请重新选择文件。');
  }
}

/** 编辑固定修订，图片上传只是草稿；保存后图片和目标作为一个配置发布。 */
function BannerEditor({ current, onClose }: { current: BannerEntry; onClose: () => void }) {
  const [draft, setDraft] = useState(current);
  const [busy, setBusy] = useState<'upload' | 'save' | null>(null);
  const [error, setError] = useState('');
  const lock = useRef(false);
  /** 完成上传校验后才替换草稿，失败时保留已选择的可用图片。 */
  async function upload(file: File | undefined) {
    if (!file || lock.current) return;
    if (!/\.(?:png|jpe?g|webp)$/i.test(file.name) || file.size === 0 || file.size > 8 * 1024 * 1024) {
      setError('请选择不超过 8 MB 的 PNG、JPEG 或 WebP 图片。');
      return;
    }
    lock.current = true;
    setBusy('upload');
    setError('');
    try {
      const data_base64 = await encodeImage(file);
      const media = await request(() => api.adminBanners.upload({ filename: file.name, data_base64 }), 'banner-upload');
      setDraft((value) => ({ ...value, image_path: media.image_path, is_enabled: true }));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }
  /** 带版本提交防止并发覆盖，成功结果立即更新列表，写请求不会自动重试。 */
  async function save() {
    if (lock.current) return;
    if (draft.is_enabled && !draft.image_path) {
      setError('请先上传图片，再启用自定义配置。');
      return;
    }
    lock.current = true;
    setBusy('save');
    setError('');
    try {
      const result = await request(
        () =>
          api.adminBanners.update(current.slot, {
            version: current.version,
            image_id: bannerImageId(draft.image_path),
            target: draft.target,
            is_enabled: draft.is_enabled,
          }),
        'banner-save',
      );
      queryClient.setQueryData<Awaited<ReturnType<typeof api.adminBanners.list>>>(queryKey, (previous) =>
        previous
          ? {
              items: previous.items.map((entry) => (entry.slot === result.slot ? result : entry)),
            }
          : previous,
      );
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }
  return (
    <Modal title={bannerSlots[current.slot].title} busy={busy !== null} onClose={onClose} className="banner-editor">
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <BannerPreview entry={draft} />
        <label className="check-row">
          <input
            type="checkbox"
            checked={draft.is_enabled}
            disabled={busy !== null}
            onChange={(event) => setDraft({ ...draft, is_enabled: event.target.checked })}
          />
          使用自定义配置
        </label>
        <label className="field">
          替换图片
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
            disabled={busy !== null}
            onChange={(event) => {
              void upload(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          <small>
            建议使用 3:1 横图，PNG / JPEG / WebP，最大 8 MB，最长边不超过 4096 像素。图片中的文字请与跳转页面保持一致。
          </small>
        </label>
        <label className="field">
          点击跳转
          <select
            value={draft.target}
            disabled={busy !== null || !draft.is_enabled}
            onChange={(event) => setDraft({ ...draft, target: event.target.value as BannerTarget })}
          >
            {Object.entries(bannerTargets).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {!draft.is_enabled && <p className="muted">当前使用应用内置图片，点击进入{bannerTargets[current.slot]}。</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <Button disabled={busy !== null} onClick={() => setDraft(defaultBanner(draft))}>
            恢复默认
          </Button>
          <Button disabled={busy !== null} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" variant="primary" disabled={busy !== null}>
            {busy === 'upload' ? '正在上传…' : busy === 'save' ? '正在保存…' : '保存配置'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
