import { createLazyPage } from '../components/lazy-page';
import { Modal } from '../components/ui';

export const BannersPage = createLazyPage(
  async () => ({ default: (await import('../features/application/banners')).BannersPage }),
  'Banner 管理',
);

export const UsersPage = createLazyPage(
  async () => ({ default: (await import('../features/application/users')).UsersPage }),
  '用户管理',
);
export const AccountsPage = createLazyPage(
  async () => ({ default: (await import('../features/system/accounts')).AccountsPage }),
  '后台用户',
);
export const GroupsPage = createLazyPage(
  async () => ({ default: (await import('../features/system/groups')).GroupsPage }),
  '用户组管理',
);
export const AuditPage = createLazyPage(
  async () => ({ default: (await import('../features/system/operation-logs')).AuditPage }),
  '操作日志',
);
export const AnalyticsOverview = createLazyPage(
  async () => ({ default: (await import('../features/analytics/overview')).AnalyticsOverview }),
  '数据概览',
);
export const EventAnalysis = createLazyPage(
  async () => ({ default: (await import('../features/analytics/events')).EventAnalysis }),
  '事件分析',
);
export const TrackingManagement = createLazyPage(
  async () => ({ default: (await import('../features/analytics/tracking')).TrackingManagement }),
  '埋点管理',
);
export const FitnessManagementPage = createLazyPage(
  async () => ({ default: (await import('../features/fitness')).FitnessManagementPage }),
  '健身管理',
);
export const PersonalCenter = createLazyPage(
  async () => ({ default: (await import('../features/personal/security')).PersonalCenter }),
  '个人中心',
  (content, { onClose }) =>
    onClose ? (
      <Modal title="个人中心" onClose={onClose}>
        {content}
      </Modal>
    ) : (
      <section className="personal-page">{content}</section>
    ),
);
