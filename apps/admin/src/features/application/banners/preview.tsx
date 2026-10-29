import { useState } from 'react';
import { reportError } from '../../../api/client';
import { Button } from '../../../components/ui';
import { bannerPreview, bannerSlots, type BannerDraft, type BannerEntry } from './model';

/** 表格图片只作为小幅预览入口，加载失败仍可打开独立预览。 */
export function BannerThumbnail({ entry, onPreview }: { entry: BannerEntry; onPreview: () => void }) {
  const source = bannerPreview(entry);
  const [failed, setFailed] = useState<string>();
  return (
    <button
      type="button"
      className="banner-thumbnail"
      aria-label={`预览${bannerSlots[entry.slot].title}`}
      onClick={onPreview}
    >
      {failed !== source ? (
        <img src={source} alt="" loading="lazy" decoding="async" onError={() => setFailed(source)} />
      ) : (
        <span>查看图片</span>
      )}
    </button>
  );
}

/** 大图仅在预览和编辑弹窗显示，失败后允许单独重新读取。 */
export function BannerPreview({ entry }: { entry: Pick<BannerDraft, 'slot' | 'image_path'> }) {
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
