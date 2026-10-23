import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Camera, UserRound } from 'lucide-react';
import { unwrap, type paths } from '@sesame-notes/api-client';
import { api, queryClient, useSession } from '../../lib/session';
import { Button, Dialog, ErrorState, Field } from '../../components/ui';
import { useProductAnalyticsPage } from '../../lib/use-product-analytics';
import { useReportDraft, type ReportDraft, type ConfirmAction } from './use-settings-guard';

type AvatarBody = paths['/api/v1/profile/avatar']['put']['requestBody']['content']['application/json'];

/** 头像只从授权接口读取，临时 Blob URL 与文件读取任务随页面生命周期释放。 */
export function AvatarEditor({
  version,
  hasAvatar,
  report,
  confirm,
}: {
  version: number;
  hasAvatar: boolean;
  report: ReportDraft;
  confirm: ConfirmAction;
}) {
  const { session } = useSession();
  const accountId = session!.user.user_id;
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [dialog, setDialog] = useState(false);
  useProductAnalyticsPage('settings.profile.avatar', dialog);
  const [removing, setRemoving] = useState(false);
  const [body, setBody] = useState<AvatarBody | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<unknown>(null);
  const generation = useRef(0);
  const activeReader = useRef<FileReader | null>(null);
  const cancelRead = useCallback(() => {
    generation.current += 1;
    const reader = activeReader.current;
    activeReader.current = null;
    if (reader) {
      reader.onload = null;
      reader.onerror = null;
      reader.onabort = null;
      if (reader.readyState === FileReader.LOADING) reader.abort();
    }
  }, []);
  useEffect(() => cancelRead, [cancelRead]);
  const avatar = useQuery({
    queryKey: ['account', accountId, 'avatar', version],
    enabled: hasAvatar,
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/profile/avatar/{user_id}', {
          params: { path: { user_id: accountId } },
          signal,
          parseAs: 'blob',
        }),
      ),
  });
  useEffect(() => {
    setImageFailed(false);
    if (!hasAvatar || !avatar.data) {
      setImageUrl(null);
      return;
    }
    const url = URL.createObjectURL(avatar.data);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [avatar.data, hasAvatar]);
  const save = useMutation({
    mutationFn: async (value: AvatarBody | null) =>
      value
        ? unwrap(await api.PUT('/api/v1/profile/avatar', { body: value }))
        : unwrap(await api.DELETE('/api/v1/profile/avatar')),
    onSuccess: async () => {
      cancelRead();
      setBody(null);
      setPreview(null);
      setReading(false);
      setRemoving(false);
      await queryClient.invalidateQueries({ queryKey: ['account', accountId, 'profile'] });
      await queryClient.invalidateQueries({ queryKey: ['account', accountId, 'avatar'] });
      setDialog(false);
    },
  });
  useReportDraft(report, 'avatar', Boolean(body) || reading, save.isPending);

  /** 每次选图递增代际并取消旧读取，旧回调即使迟到也不能覆盖新图片或重开弹窗。 */
  function choose(file: File | undefined) {
    cancelRead();
    setFileError(null);
    setBody(null);
    setPreview(null);
    setReading(false);
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setFileError(new Error('请选择 PNG、JPEG 或 WebP 图片。'));
      return;
    }
    if (file.size === 0 || file.size > 8 * 1024 * 1024) {
      setFileError(new Error(file.size === 0 ? '图片内容为空，请重新选择。' : '图片不能超过 8 MB。'));
      return;
    }
    const current = generation.current;
    try {
      const reader = new FileReader();
      activeReader.current = reader;
      setReading(true);
      reader.onload = () => {
        if (generation.current !== current) return;
        activeReader.current = null;
        setReading(false);
        const result = reader.result;
        const data = typeof result === 'string' ? result.split(',')[1] : undefined;
        if (!data || typeof result !== 'string') {
          setFileError(new Error('无法读取图片，请重新选择。'));
          return;
        }
        setPreview(result);
        setBody({ content_type: file.type as AvatarBody['content_type'], data_base64: data });
      };
      reader.onerror = () => {
        if (generation.current !== current) return;
        activeReader.current = null;
        setReading(false);
        setFileError(new Error('无法读取图片，请重新选择。'));
      };
      reader.readAsDataURL(file);
    } catch (error) {
      if (generation.current !== current) return;
      activeReader.current = null;
      setReading(false);
      setFileError(error);
    }
  }
  /** 放弃所选图片时清除临时内容，取消尚未完成的 FileReader。 */
  function close() {
    if (save.isPending) return;
    confirm(
      () => {
        cancelRead();
        setDialog(false);
        setBody(null);
        setPreview(null);
        setReading(false);
        setFileError(null);
      },
      Boolean(body) || reading,
    );
  }
  return (
    <>
      <button
        className="profile-avatar avatar-editor-trigger"
        type="button"
        aria-label="更换头像"
        onClick={() => {
          setDialog(true);
          setFileError(null);
          save.reset();
        }}
      >
        {imageUrl && !imageFailed ? (
          <img src={imageUrl} alt="我的头像" onError={() => setImageFailed(true)} />
        ) : (
          <UserRound size={28} />
        )}
        <span>
          <Camera size={12} />
        </span>
      </button>
      <Dialog open={dialog} title="更换头像" description="支持 PNG、JPEG 和 WebP，最大 8 MB。" onClose={close}>
        <div className="stack">
          {(avatar.isError || imageFailed) && (
            <div role="status" className="notice">
              <p>当前头像暂时无法读取。你可以重试读取，或选择新图片替换。</p>
              <Button
                variant="secondary"
                onClick={() => {
                  setImageFailed(false);
                  void avatar.refetch();
                }}
              >
                重新读取头像
              </Button>
            </div>
          )}
          {preview && <img className="avatar-preview" alt="新头像预览" src={preview} />}
          <Field label="选择图片">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={save.isPending}
              onChange={(event) => {
                choose(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </Field>
          {reading && (
            <p role="status" className="muted">
              正在读取所选图片…
            </p>
          )}
          {fileError !== null && <ErrorState error={fileError} />}
          {save.isError && <ErrorState error={save.error} />}
          <div className="toolbar">
            <Button
              disabled={!body || reading || save.isPending}
              onClick={() => {
                if (body) save.mutate(body);
              }}
            >
              {save.isPending ? '保存中…' : '保存头像'}
            </Button>
            {hasAvatar && (
              <Button variant="secondary" disabled={save.isPending || reading} onClick={() => setRemoving(true)}>
                恢复默认头像
              </Button>
            )}
          </div>
        </div>
      </Dialog>
      <Dialog
        open={removing}
        title="恢复默认头像？"
        description="已保存的自定义头像会移除，其他设备也会同步这个变化。"
        onClose={() => {
          if (!save.isPending) setRemoving(false);
        }}
      >
        {save.isError && <ErrorState error={save.error} />}
        <div className="toolbar">
          <Button variant="danger" disabled={save.isPending} onClick={() => save.mutate(null)}>
            {save.isPending ? '处理中…' : '确认恢复默认头像'}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
