import { UserRound } from 'lucide-react';
import { useState } from 'react';
import { reportError } from '../../../api/client';
import type { UserDetail } from '../../../api/types';

type AvatarUser = Pick<UserDetail, 'id' | 'avatar_url' | 'avatar_version'>;

/** 只使用后台授权接口返回的相对地址，避免用户图片地址绕过管理会话读取范围。 */
export function userAvatarUrl(user: Pick<UserDetail, 'avatar_url'>): string | null {
  return user.avatar_url?.startsWith('/api/v1/admin/users/') ? user.avatar_url : null;
}

/** 列表与详情共用头像展示，读取失败回退默认图标，新版本头像可重新加载。 */
export function UserAvatar({ user }: { user: AvatarUser }) {
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const avatar = userAvatarUrl(user);
  const avatarKey = `${user.id}:${user.avatar_version}:${avatar}`;

  /** 失败状态关联当前头像版本，旧图片的迟到事件不会隐藏后续更新的头像。 */
  function fail(): void {
    setFailedAvatar(avatarKey);
    reportError('user-avatar-image', new Error('用户头像图片暂时无法读取'));
  }

  return avatar && failedAvatar !== avatarKey ? (
    <img key={avatarKey} className="user-avatar" src={avatar} alt="用户头像" onError={fail} />
  ) : (
    <span
      className="user-avatar"
      role="img"
      aria-label={avatar ? '头像暂时无法显示' : '默认用户头像'}
      title={avatar ? '头像暂时无法显示' : '默认用户头像'}
    >
      <UserRound size={24} aria-hidden="true" />
    </span>
  );
}
