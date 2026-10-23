import { useState } from 'react';
import { Dumbbell, ImageOff } from 'lucide-react';

/** 只使用服务端公开素材路径，静态预览与完整演示分别请求同一资源的对应版本。 */
export function exerciseMediaUrl(source: string | undefined, preview = false): string | undefined {
  if (!source) return undefined;
  try {
    const url = new URL(source, window.location.origin);
    if (
      url.origin !== window.location.origin ||
      !/^\/api\/v1\/fitness\/media\/(?:[a-f0-9]{64}|builtin-[\w-]{1,128})$/.test(url.pathname)
    ) {
      throw new Error('动作素材地址不属于当前站点的公开素材接口');
    }
    url.searchParams.delete('preview');
    if (preview) url.searchParams.set('preview', '1');
    url.hash = '';
    return `${url.pathname}${url.search}`;
  } catch (error) {
    console.error('解析动作素材地址失败', { error });
    return undefined;
  }
}

/** 列表只请求静态首帧，缺失或失败使用占位，完整动画由详情组件按需加载。 */
export function ExerciseThumbnail({ name, source }: { name: string; source?: string }) {
  const [failed, setFailed] = useState(false);
  const preview = exerciseMediaUrl(source, true);
  return (
    <span className="fitness-exercise-thumbnail">
      {preview && !failed ? (
        <img
          src={preview}
          alt={`${name}静态预览`}
          width={96}
          height={96}
          loading="lazy"
          decoding="async"
          onError={() => {
            console.warn('动作静态预览加载失败', { preview });
            setFailed(true);
          }}
        />
      ) : (
        <span className="fitness-exercise-placeholder" aria-label={`${name}${failed ? '预览暂不可用' : '暂无预览'}`}>
          {failed ? <ImageOff size={24} aria-hidden="true" /> : <Dumbbell size={24} aria-hidden="true" />}
          <small>{failed ? '预览暂不可用' : '暂无预览'}</small>
        </span>
      )}
    </span>
  );
}

/** 仅在动作详情中挂载完整演示，加载失败时仍可阅读动作步骤。 */
export function ExerciseMedia({ name, source }: { name: string; source?: string }) {
  const [failed, setFailed] = useState(false);
  const url = exerciseMediaUrl(source);
  if (!url || failed)
    return (
      <p className="fitness-info">
        {failed ? '演示暂时无法加载，可参考下方动作步骤。' : '暂无动作演示，可参考下方动作步骤。'}
      </p>
    );
  return (
    <img
      className="fitness-exercise-image"
      src={url}
      alt={`${name}动作演示`}
      decoding="async"
      onError={() => {
        console.warn('动作演示加载失败', { url });
        setFailed(true);
      }}
    />
  );
}
