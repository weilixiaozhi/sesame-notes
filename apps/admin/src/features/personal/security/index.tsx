import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import type { z } from 'zod';
import { Button, Modal } from '../../../components/ui';
import { useSession } from '../../../auth/session';
import { api, errorMessage, request } from '../../../api/client';
import { passwordSchema } from '../../../lib/validation';
import { dateTime, identityLabel } from '../../../api/types';

/** 本人中心复用同一内容，无业务权限时直接展示，其余情况仅从左下账号入口打开。 */
export function PersonalCenter({ onClose }: { onClose?: () => void }) {
  const session = useSession();
  const admin = session.session!.admin;
  const [error, setError] = useState('');
  const form = useForm<z.infer<typeof passwordSchema>>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { old_password: '', new_password: '', confirmation: '' },
  });
  /** 主动改密成功后移除全部会话资料，必须重新登录。 */
  async function submit(value: z.infer<typeof passwordSchema>) {
    setError('');
    try {
      await request(
        () => api.adminAuth.changePassword({ old_password: value.old_password, new_password: value.new_password }),
        'change-own-password',
      );
      form.reset();
      session.end('密码已更新，请使用新密码重新登录。');
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  const content = (
    <div className="form-stack">
      <dl className="detail-grid">
        <div>
          <dt>登录账号</dt>
          <dd>{admin.username}</dd>
        </div>
        <div>
          <dt>显示名称</dt>
          <dd>{admin.display_name}</dd>
        </div>
        <div>
          <dt>邮箱</dt>
          <dd>{admin.email || '未设置'}</dd>
        </div>
        <div>
          <dt>手机号</dt>
          <dd>{admin.phone || '未设置'}</dd>
        </div>
        <div>
          <dt>身份</dt>
          <dd>{identityLabel(admin.identity_type)}</dd>
        </div>
        <div>
          <dt>用户组</dt>
          <dd>{admin.group.name}</dd>
        </div>
        <div>
          <dt>会话到期</dt>
          <dd>{dateTime(session.session!.expires_at)}</dd>
        </div>
      </dl>
      <form className="form-stack" onSubmit={form.handleSubmit(submit)}>
        <h3>修改密码</h3>
        <label className="field">
          当前密码
          <input {...form.register('old_password')} type="password" autoComplete="current-password" />
        </label>
        <label className="field">
          新密码
          <input {...form.register('new_password')} type="password" autoComplete="new-password" />
        </label>
        <label className="field">
          确认新密码
          <input {...form.register('confirmation')} type="password" autoComplete="new-password" />
        </label>
        {(error || Object.keys(form.formState.errors).length > 0) && (
          <div role="alert" className="form-error">
            {error || Object.values(form.formState.errors)[0]?.message}
          </div>
        )}
        <div className="notice">修改密码后全部后台会话失效，需要重新登录。</div>
        <Button
          variant="primary"
          disabled={form.formState.isSubmitting}
          onClick={() => void form.handleSubmit(submit)()}
        >
          修改并重新登录
        </Button>
      </form>
      <div className="dialog-actions">
        <Button onClick={() => void session.logout()}>退出登录</Button>
      </div>
    </div>
  );
  return onClose ? (
    <Modal title="个人中心" onClose={onClose} busy={form.formState.isSubmitting}>
      {content}
    </Modal>
  ) : (
    <section className="personal-page">
      <h1>个人中心</h1>
      {content}
    </section>
  );
}
