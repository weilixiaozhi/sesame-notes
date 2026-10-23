import { useEffect, useState, useSyncExternalStore } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Check, Laptop, LogOut, Smartphone } from 'lucide-react';
import { unwrap, type paths } from '@sesame-notes/api-client';
import { api, queryClient, useSession } from '../../lib/session';
import { Button, Dialog, ErrorState, Field, LoadingState, PageHeading } from '../../components/ui';
import { AvatarEditor } from './avatar-editor';
import {
  getDesignStyleSnapshot,
  getServerDesignStyleSnapshot,
  setDesignStyle,
  subscribeDesignStyle,
  type DesignStyle,
} from '../../lib/design-style';
import './settings-page.css';
import { useSettingsGuard, useReportDraft, type ReportDraft, type ConfirmAction } from './use-settings-guard';

type Profile = paths['/api/v1/profile/me']['get']['responses'][200]['content']['application/json'];
const profileSchema = z.object({
  name: z.string().trim().min(1, '请输入昵称').max(100, '昵称最多 100 个字符'),
  gender: z.enum(['UNSPECIFIED', 'MALE', 'FEMALE']),
});
const passwordSchema = z
  .object({
    current: z.string().min(1, '请输入当前密码').max(128, '密码最多 128 个字符'),
    next: z.string().min(1, '请输入新密码').max(128, '新密码最多 128 个字符'),
    confirm: z.string(),
  })
  .refine((value) => value.next === value.confirm, { path: ['confirm'], message: '两次输入的新密码不一致' });

/** 账号信息和设备列表都按当前账号隔离缓存。 */
export function SettingsPage() {
  const { session, logout } = useSession();
  const guard = useSettingsGuard();
  const [loggingOut, setLoggingOut] = useState(false);
  const profile = useQuery({
    queryKey: ['account', session?.user.user_id, 'profile'],
    queryFn: async ({ signal }) => unwrap(await api.GET('/api/v1/profile/me', { signal })),
  });
  return (
    <div className="stack settings-page">
      <PageHeading title="账号与设置" />
      {profile.isPending ? (
        <LoadingState />
      ) : profile.isError ? (
        <ErrorState error={profile.error} retry={() => void profile.refetch()} />
      ) : (
        <ProfileForm key={profile.data.user_id} profile={profile.data} report={guard.report} confirm={guard.confirm} />
      )}
      <section className="panel settings-appearance">
        <div>
          <h2>网页外观</h2>
          <p className="muted">仅影响当前浏览器。</p>
        </div>
        <ThemeSelector />
        <DesignStyleSelector />
      </section>
      <PasswordForm report={guard.report} />
      <Devices report={guard.report} />

      <section className="panel settings-signout">
        <div>
          <h2>退出当前账号</h2>
          <p className="muted">此浏览器的其他标签页也会退出，手机登录不受影响。</p>
        </div>
        <Button
          variant="secondary"
          disabled={loggingOut || guard.pending}
          onClick={() =>
            guard.confirm(
              async () => {
                setLoggingOut(true);
                try {
                  await logout();
                } finally {
                  setLoggingOut(false);
                }
              },
              undefined,
              true,
            )
          }
        >
          <LogOut size={16} />
          {loggingOut ? '正在退出…' : '退出登录'}
        </Button>
        {guard.confirmation}
      </section>
    </div>
  );
}

/** 只提交可编辑的资料字段，不覆盖客户端外观和其他账号配置。 */
function ProfileForm({ profile, report, confirm }: { profile: Profile; report: ReportDraft; confirm: ConfirmAction }) {
  const form = useForm<z.infer<typeof profileSchema>>({
    resolver: zodResolver(profileSchema),
    defaultValues: { name: profile.display_name ?? '', gender: profile.gender },
  });
  const save = useMutation({
    mutationFn: async (values: z.infer<typeof profileSchema>) =>
      unwrap(
        await api.PATCH('/api/v1/profile/me', {
          body: {
            ...(form.formState.dirtyFields.name ? { display_name: values.name } : {}),
            ...(form.formState.dirtyFields.gender ? { gender: values.gender } : {}),
          },
        }),
      ),
    onSuccess: async (saved) => {
      queryClient.setQueryData(['account', profile.user_id, 'profile'], saved);
      form.reset({ name: saved.display_name ?? '', gender: saved.gender });
    },
  });
  useEffect(() => {
    // 没有本地草稿时展示其他设备的新资料；编辑中只保留用户正在输入的值。
    if (!form.formState.isDirty && !save.isPending)
      form.reset({ name: profile.display_name ?? '', gender: profile.gender });
  }, [profile.display_name, profile.gender, form, form.formState.isDirty, save.isPending]);
  useReportDraft(report, 'profile', form.formState.isDirty, save.isPending);
  return (
    <section className="panel profile-panel">
      <AvatarEditor
        version={profile.avatar_version}
        hasAvatar={profile.avatar_url !== null}
        report={report}
        confirm={confirm}
      />
      <div className="stack">
        <div>
          <h2>个人资料</h2>
          <p className="muted">
            芝麻号 {profile.sesame_number ?? '—'} · {profile.phone}
          </p>
        </div>
        <form
          className="stack"
          onSubmit={form.handleSubmit((values) => save.mutateAsync(values).catch(() => undefined))}
        >
          <fieldset
            className="stack"
            disabled={save.isPending}
            style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
          >
            <div className="form-grid">
              <Field label="昵称" error={form.formState.errors.name?.message}>
                <input autoComplete="nickname" {...form.register('name')} />
              </Field>
              <Field label="性别">
                <select {...form.register('gender')}>
                  <option value="UNSPECIFIED">未设置</option>
                  <option value="MALE">男</option>
                  <option value="FEMALE">女</option>
                </select>
              </Field>
            </div>
            {save.isError && <ErrorState error={save.error} />}
            <div className="toolbar">
              <Button type="submit" disabled={save.isPending || !form.formState.isDirty}>
                {save.isPending ? '保存中…' : '保存资料'}
              </Button>
              {save.isSuccess && !form.formState.isDirty && (
                <span role="status" className="success-text">
                  <Check size={16} />
                  已保存
                </span>
              )}
            </div>
          </fieldset>
        </form>
      </div>
    </section>
  );
}

/** 密码更新后撤销其他设备，保留服务端确认有效的当前会话。 */
function PasswordForm({ report }: { report: ReportDraft }) {
  const [changed, setChanged] = useState(false);
  const form = useForm<z.infer<typeof passwordSchema>>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { current: '', next: '', confirm: '' },
  });
  const save = useMutation({
    mutationFn: async (values: z.infer<typeof passwordSchema>) =>
      unwrap(
        await api.PATCH('/api/v1/auth/password', {
          body: { current_password: values.current, new_password: values.next },
        }),
      ),
    onSuccess: () => {
      setChanged(true);
      form.reset();
      void queryClient.invalidateQueries({ queryKey: ['account'] });
    },
  });
  useReportDraft(report, 'password', form.formState.isDirty, save.isPending);
  return (
    <section className="panel stack settings-password">
      <h2>账号安全</h2>
      {changed ? (
        <div role="status" className="stack">
          <p>密码已更新，其他设备已退出登录。当前浏览器可以继续使用。</p>
          <Button variant="secondary" onClick={() => setChanged(false)}>
            再次修改密码
          </Button>
        </div>
      ) : (
        <form
          className="stack"
          onSubmit={form.handleSubmit((values) => save.mutateAsync(values).catch(() => undefined))}
        >
          <fieldset
            className="stack"
            disabled={save.isPending}
            style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
          >
            <div className="settings-password-fields">
              <Field label="当前密码" error={form.formState.errors.current?.message}>
                <input type="password" autoComplete="current-password" maxLength={128} {...form.register('current')} />
              </Field>
              <Field label="新密码" error={form.formState.errors.next?.message} hint="最多 128 个字符。">
                <input type="password" autoComplete="new-password" maxLength={128} {...form.register('next')} />
              </Field>
              <Field label="确认新密码" error={form.formState.errors.confirm?.message}>
                <input type="password" autoComplete="new-password" maxLength={128} {...form.register('confirm')} />
              </Field>
            </div>
            {save.isError && <ErrorState error={save.error} />}
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? '保存中…' : '修改密码'}
            </Button>
          </fieldset>
        </form>
      )}
    </section>
  );
}

/** 用两张可选择的预览展示设计风格，与显示模式独立保存并立即应用。 */
function DesignStyleSelector() {
  const preference = useSyncExternalStore(subscribeDesignStyle, getDesignStyleSnapshot, getServerDesignStyleSnapshot);
  const choices: { value: DesignStyle; label: string; description: string }[] = [
    { value: 'minimal', label: '极简清单', description: '清晰留白，细线条与整齐记录' },
    { value: 'warm', label: '温暖手账', description: '纸感底色，鼠尾草绿与温和标题' },
  ];
  return (
    <fieldset className="settings-design-style">
      <legend>设计风格</legend>
      <div className="design-style-options">
        {choices.map((choice) => (
          <label className="design-style-option" key={choice.value}>
            <input
              type="radio"
              name="sesame-design-style"
              aria-label={choice.label}
              value={choice.value}
              checked={preference.style === choice.value}
              onChange={() => setDesignStyle(choice.value)}
            />
            <span className={`design-style-preview preview-${choice.value}`} aria-hidden="true">
              <span className="design-preview-title">日常生活</span>
              <span className="design-preview-tabs">
                <span>日常</span>
                <span>旅行</span>
              </span>
              <span className="design-preview-row" />
              <span className="design-preview-row" />
            </span>
            <span className="design-style-caption">
              <strong>{choice.label}</strong>
              <span>{choice.description}</span>
            </span>
          </label>
        ))}
      </div>
      {preference.error && (
        <div className="design-style-feedback">
          <p role="alert" className="design-style-error">
            {preference.error}
          </p>
          <Button variant="ghost" size="sm" onClick={() => setDesignStyle(preference.style)}>
            重试保存风格
          </Button>
        </div>
      )}
    </fieldset>
  );
}

/** 外观偏好不含个人信息，允许安全地保存在当前浏览器。 */
function ThemeSelector() {
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem('sesame-web-theme') ?? 'system';
    } catch {
      return 'system';
    }
  });
  return (
    <Field label="显示模式">
      <select
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          setValue(next);
          document.documentElement.dataset.theme = next;
          try {
            localStorage.setItem('sesame-web-theme', next);
          } catch {
            /* 浏览器关闭存储时仍允许本次外观选择。 */
          }
        }}
      >
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
    </Field>
  );
}

/** 撤销其他设备前明确显示目标，当前设备统一走退出登录。 */
function Devices({ report }: { report: ReportDraft }) {
  const { session } = useSession();
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  const devices = useQuery({
    queryKey: ['account', session?.user.user_id, 'devices'],
    queryFn: async ({ signal }) => unwrap(await api.GET('/api/v1/devices', { signal })),
  });
  const revoke = useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/v1/devices/{device_id}', { params: { path: { device_id: id } } })),
    onSuccess: async () => {
      setTarget(null);
      await devices.refetch();
    },
  });
  useReportDraft(report, 'devices', false, revoke.isPending);
  return (
    <section className="panel stack">
      <div>
        <h2>登录设备</h2>
      </div>
      {devices.isPending ? (
        <LoadingState />
      ) : devices.isError ? (
        <ErrorState error={devices.error} retry={() => void devices.refetch()} />
      ) : (
        <div className="device-list">
          {devices.data
            .filter((device) => !device.revoked_at)
            .map((device) => (
              <div key={device.id} className="device-row">
                {device.platform === 'web' ? <Laptop size={22} /> : <Smartphone size={22} />}
                <div>
                  <strong>{device.name}</strong>
                  <p className="muted">
                    {device.platform} · 最近活跃 {new Date(device.last_seen_at).toLocaleString('zh-CN')}
                  </p>
                </div>
                {device.current ? (
                  <span className="badge">当前设备</span>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      revoke.reset();
                      setTarget(device);
                    }}
                  >
                    移除
                  </Button>
                )}
              </div>
            ))}
        </div>
      )}
      <Dialog
        open={target !== null}
        onClose={() => {
          if (!revoke.isPending) setTarget(null);
        }}
        title="移除登录设备"
        description={`确认将“${target?.name ?? ''}”退出登录？`}
      >
        <div className="stack">
          {revoke.isError && <ErrorState error={revoke.error} />}
          <div className="toolbar">
            <Button
              variant="danger"
              disabled={revoke.isPending}
              onClick={() => {
                if (target) revoke.mutate(target.id);
              }}
            >
              确认移除
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}
