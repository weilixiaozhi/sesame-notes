import { phoneRegions } from '@sesame-notes/api-client';
import { useEffect, useRef, useState } from 'react';
import { api, InputError, request } from '../../../api/client';
import type { UserDetail } from '../../../api/types';
import { queryClient } from '../../../auth/session';
import { ConfirmDialog } from '../../../components/ui';
import { avatarFileError, encodeAvatar, userPasswordSchema, userPhoneSchema } from './user-input';
import type { AvatarContentType } from './user-input';

type DialogProps = { user: UserDetail; onClose: () => void; onSaved: (message: string) => void };

/** 变更后重新核对用户列表、详情与设备；失败也刷新以发现并发修改或结果不明的写入。 */
async function updateUser(operation: () => Promise<unknown>, context: string): Promise<void> {
  try {
    await request(operation, context);
  } finally {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
  }
}

/** 换绑必须明确选择区号并携带打开弹窗时的原手机号，避免覆盖其他管理员的修改。 */
export function ChangePhoneDialog({ user, onClose, onSaved }: DialogProps) {
  const [countryCode, setCountryCode] = useState('+86');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  /** 校验与规范化新号码后提交换绑，成功后提醒管理员使用新号码登录。 */
  async function save(reason: string) {
    if (lock.current) return;
    const parsed = userPhoneSchema.safeParse({ country_code: countryCode, phone });
    if (!parsed.success) throw new InputError(parsed.error.issues[0]?.message || '请检查手机号。');
    if (`${parsed.data.country_code}${parsed.data.phone}` === user.phone)
      throw new InputError('新手机号与当前手机号相同。');
    lock.current = true;
    setBusy(true);
    try {
      await updateUser(
        () => api.adminUsers.changePhone(user.id, { ...parsed.data, current_phone: user.phone, reason }),
        'change-user-phone',
      );
      onSaved('手机号已换绑，用户需要使用新手机号重新登录。');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog title="换绑手机号" confirmText="确认换绑" onClose={onClose} onConfirm={save}>
      <div className="impact">
        <strong>{user.display_name || '未设置昵称'}</strong>
        <p>芝麻号：{user.sesame_number}</p>
        <p>当前手机号：{user.phone}</p>
      </div>
      <div className="field-row">
        <label className="field">
          国家或地区区号
          <select value={countryCode} disabled={busy} onChange={(event) => setCountryCode(event.target.value)}>
            {phoneRegions.map((region) => (
              <option key={region.code} value={region.code}>
                {region.label} {region.code}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          新手机号
          <input
            type="tel"
            inputMode="tel"
            autoComplete="off"
            value={phone}
            maxLength={32}
            disabled={busy}
            placeholder="无需重复填写区号"
            onChange={(event) => setPhone(event.target.value)}
          />
        </label>
      </div>
      <p>换绑后，用户在所有设备上的现有登录将失效，需要使用新手机号和原密码重新登录。用户资料和业务数据保留。</p>
    </ConfirmDialog>
  );
}

/** 只允许设置新密码，密码仅驻留本次弹窗内存，提交后及关闭时清除。 */
export function ResetPasswordDialog({ user, onClose, onSaved }: DialogProps) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  /** 原样校验两次密码，不能裁剪空格或沿用后台账号密码规则。 */
  async function save(reason: string) {
    if (lock.current) return;
    const parsed = userPasswordSchema.safeParse({ new_password: password, confirmation });
    if (!parsed.success) throw new InputError(parsed.error.issues[0]?.message || '请检查新密码。');
    lock.current = true;
    setBusy(true);
    try {
      await updateUser(
        () => api.adminUsers.resetPassword(user.id, { new_password: parsed.data.new_password, reason }),
        'reset-user-password',
      );
      onSaved('密码已重置，用户需要使用新密码重新登录。');
    } finally {
      setPassword('');
      setConfirmation('');
      lock.current = false;
      setBusy(false);
    }
  }

  /** 主动清空敏感输入后退出弹窗，取消操作不发出写请求。 */
  function close() {
    setPassword('');
    setConfirmation('');
    onClose();
  }

  return (
    <ConfirmDialog title="重置用户密码" confirmText="确认重置密码" onClose={close} onConfirm={save}>
      <div className="impact">
        <strong>{user.display_name || '未设置昵称'}</strong>
        <p>芝麻号：{user.sesame_number}</p>
        <p>手机号：{user.phone}</p>
      </div>
      <label className="field">
        新密码
        <input
          type="password"
          autoComplete="new-password"
          maxLength={128}
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <label className="field">
        确认新密码
        <input
          type="password"
          autoComplete="new-password"
          maxLength={128}
          value={confirmation}
          disabled={busy}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </label>
      <p>重置后，用户在所有设备上的现有登录将失效，需要使用新密码重新登录。用户资料和业务数据保留。</p>
    </ConfirmDialog>
  );
}

/** 文件选择仅生成本地预览，填写原因并确认后才更换头像。 */
export function ChangeAvatarDialog({ user, onClose, onSaved }: DialogProps) {
  const [selection, setSelection] = useState<{ content_type: AvatarContentType; data_base64: string } | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const lock = useRef(false);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  /** 代际编号隔离连续选择与关闭后的迟到读取，旧图片不能覆盖最新选择。 */
  async function choose(file: File | undefined) {
    const current = ++generation.current;
    setSelection(null);
    setError('');
    setReading(false);
    if (!file) return;
    const invalid = avatarFileError(file);
    if (invalid) {
      setError(invalid);
      return;
    }
    setReading(true);
    try {
      const data = await request(() => encodeAvatar(file), 'read-user-avatar');
      if (generation.current !== current) return;
      setSelection({ content_type: file.type as AvatarContentType, data_base64: data });
    } catch {
      if (generation.current === current) setError('无法读取图片，请重新选择。');
    } finally {
      if (generation.current === current) setReading(false);
    }
  }

  /** 携带原头像版本提交更新，并在写入结束后释放本地图片内容。 */
  async function save(reason: string) {
    if (lock.current) return;
    if (!selection || reading) throw new InputError('请先选择有效图片并等待预览完成。');
    lock.current = true;
    setBusy(true);
    try {
      await updateUser(
        () => api.adminUsers.uploadAvatar(user.id, { ...selection, avatar_version: user.avatar_version, reason }),
        'change-user-avatar',
      );
      setSelection(null);
      onSaved('用户头像已更新。');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      title="更换用户头像"
      confirmText="保存头像"
      danger={false}
      confirmDisabled={!selection || reading}
      onClose={onClose}
      onConfirm={save}
    >
      <p>
        用户：{user.display_name || '未设置昵称'} · {user.sesame_number}
      </p>
      {selection && (
        <img
          className="user-avatar user-avatar-preview"
          alt="新头像预览"
          src={`data:${selection.content_type};base64,${selection.data_base64}`}
          onError={() => {
            setSelection(null);
            setError('图片无法正常显示，请选择有效的 PNG、JPEG 或 WebP 图片。');
          }}
        />
      )}
      <label className="field">
        选择图片
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={busy}
          onChange={(event) => {
            void choose(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </label>
      <small>支持 PNG、JPEG 和 WebP，最大 8 MB。确认保存后生效。</small>
      {reading && <p role="status">正在读取所选图片…</p>}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
    </ConfirmDialog>
  );
}

/** 恢复默认头像前明确确认影响，并使用版本检查防止删除其他人新上传的头像。 */
export function DeleteAvatarDialog({ user, onClose, onSaved }: DialogProps) {
  const lock = useRef(false);

  /** 删除成功后刷新所有用户数据，由服务端响应决定头像最终状态。 */
  async function remove(reason: string) {
    if (lock.current) return;
    lock.current = true;
    try {
      await updateUser(
        () => api.adminUsers.deleteAvatar(user.id, { avatar_version: user.avatar_version, reason }),
        'delete-user-avatar',
      );
      onSaved('已恢复默认头像。');
    } finally {
      lock.current = false;
    }
  }

  return (
    <ConfirmDialog title="恢复默认头像" confirmText="确认恢复默认头像" onClose={onClose} onConfirm={remove}>
      <p>
        用户：{user.display_name || '未设置昵称'} · {user.sesame_number}
      </p>
      <p>用户的自定义头像将被移除，并同步到其他设备。其余用户资料和业务数据保留。</p>
    </ConfirmDialog>
  );
}
