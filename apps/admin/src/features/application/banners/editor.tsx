import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, errorMessage, InputError, reportError, request } from '../../../api/client';
import { Button, Loading, Modal, RequestError } from '../../../components/ui';
import {
  bannerImageId,
  bannerSlots,
  bannerTargets,
  builtinBanner,
  type BannerEntry,
  type BannerSlot,
  type BannerTarget,
} from './model';
import { BannerPreview } from './preview';
import { refreshBanners } from './operations';

/** 图片只在本次上传中编码，不把正文写入日志或浏览器持久存储。 */
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

/** 每张轮播图独立配置位置、图片、跳转和顺序，不包含投放时间或上下线状态。 */
export function BannerEditor({
  current,
  initialSlot,
  onClose,
}: {
  current?: BannerEntry;
  initialSlot: BannerSlot;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<BannerEntry>(() => current ?? builtinBanner(initialSlot));
  const [busy, setBusy] = useState<'upload' | 'save' | null>(null);
  const [error, setError] = useState('');
  const [targetSearch, setTargetSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const lock = useRef(false);
  const official = draft.target === 'official-plan' || draft.target === 'official-template';
  const kind = draft.target === 'official-plan' ? 'plan' : 'template';
  const targets = useQuery({
    queryKey: ['admin', 'banner-targets', kind, targetSearch],
    enabled: official,
    queryFn: ({ signal }) =>
      request(() => api.adminBanners.targets({ kind, q: targetSearch || undefined }, signal), 'banner-targets'),
  });

  /** 上传完成并经服务端校验后才替换草稿，失败时保留此前图片。 */
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
      setDraft((value) => ({ ...value, image_path: media.image_path, source: 'remote' }));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }

  /** 保存时再次由服务端校验官方内容可用性，编辑同时携带固定修订避免并发覆盖。 */
  async function save() {
    if (lock.current) return;
    if (!draft.image_path) {
      setError('请选择图片。');
      return;
    }
    if (official && (!draft.target_id || targets.isPending || targets.isError)) {
      setError('请加载并选择要跳转的官方内容。');
      return;
    }
    lock.current = true;
    setBusy('save');
    setError('');
    try {
      const body = {
        slot: draft.slot,
        image_id: bannerImageId(draft.image_path)!,
        target: draft.target,
        target_id: official ? draft.target_id : null,
        sort_order: draft.sort_order,
      };
      await request(
        () =>
          current
            ? api.adminBanners.update(current.id, { ...body, version: current.version })
            : api.adminBanners.create(body),
        'banner-save',
      );
      await refreshBanners();
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }

  return (
    <Modal
      title={current ? '修改 Banner' : '添加 Banner'}
      busy={busy !== null}
      onClose={onClose}
      className="banner-editor"
    >
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="banner-form-grid">
          <label className="field">
            展示位置
            <select
              value={draft.slot}
              disabled={busy !== null}
              onChange={(event) => setDraft({ ...draft, slot: event.target.value as BannerSlot })}
            >
              {Object.entries(bannerSlots).map(([value, entry]) => (
                <option key={value} value={value}>
                  {entry.title}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            显示顺序
            <input
              type="number"
              required
              min={0}
              max={9999}
              value={draft.sort_order}
              disabled={busy !== null}
              onChange={(event) => setDraft({ ...draft, sort_order: event.target.valueAsNumber })}
            />
            <small>数字越小越靠前。</small>
          </label>
        </div>
        <label className="field">
          Banner 图片
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
            disabled={busy !== null}
            onChange={(event) => {
              void upload(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          <small>建议 3:1 横图，PNG / JPEG / WebP，最大 8 MB，最长边不超过 4096 像素。</small>
        </label>
        {draft.image_path && <BannerPreview entry={draft} />}
        <label className="field">
          跳转目标
          <select
            value={draft.target}
            disabled={busy !== null}
            onChange={(event) => {
              setDraft({ ...draft, target: event.target.value as BannerTarget, target_id: null, target_name: null });
              setSearchInput('');
              setTargetSearch('');
            }}
          >
            {Object.entries(bannerTargets).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {official && (
          <>
            <div className="banner-target-search">
              <label className="field">
                查找官方{kind === 'plan' ? '计划' : '模板'}
                <input
                  value={searchInput}
                  disabled={busy !== null}
                  onChange={(event) => setSearchInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      setTargetSearch(searchInput.trim());
                    }
                  }}
                />
              </label>
              <Button
                disabled={busy !== null || targets.isFetching}
                onClick={() => {
                  if (targetSearch === searchInput.trim()) void targets.refetch();
                  else setTargetSearch(searchInput.trim());
                }}
              >
                查找
              </Button>
            </div>
            {targets.isPending ? (
              <Loading label="正在加载官方内容…" />
            ) : targets.isError ? (
              <RequestError error={targets.error} retry={() => void targets.refetch()} />
            ) : (
              <label className="field">
                选择官方{kind === 'plan' ? '计划' : '模板'}
                <select
                  required
                  value={draft.target_id ?? ''}
                  disabled={busy !== null}
                  onChange={(event) => {
                    const chosen = targets.data.items.find((item) => item.id === event.target.value);
                    setDraft({ ...draft, target_id: chosen?.id ?? null, target_name: chosen?.name.zh ?? null });
                  }}
                >
                  <option value="">请选择</option>
                  {draft.target_id && !targets.data.items.some((item) => item.id === draft.target_id) && (
                    <option value={draft.target_id}>{draft.target_name || '已选择内容，请核对是否可用'}</option>
                  )}
                  {targets.data.items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name.zh}
                    </option>
                  ))}
                </select>
                {!targets.data.items.length && <small>没有匹配的官方内容。</small>}
              </label>
            )}
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <Button disabled={busy !== null} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" variant="primary" disabled={busy !== null}>
            {busy === 'upload' ? '正在上传…' : busy === 'save' ? '正在保存…' : '保存'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
