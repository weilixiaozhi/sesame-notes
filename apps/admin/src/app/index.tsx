import { Component, useEffect, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import {
  AppWindow,
  BarChart3,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Dumbbell,
  Layers,
  Menu,
  Settings2,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import { Button, Loading } from '../components/ui';
import { useSession } from '../auth/session';
import { canAccess, landingPath, pageInfo } from '../api/types';
import type { PageId } from '../api/types';
import { reportError } from '../api/client';
import { LoginPage } from '../features/authentication';
import { canonicalPath, routePage } from './routes';
import {
  PersonalCenter,
  UsersPage,
  AccountsPage,
  GroupsPage,
  AuditPage,
  AnalyticsOverview,
  EventAnalysis,
  TrackingManagement,
  FitnessManagementPage,
} from './lazy-pages';

/** 版本来自当前管理后台构建产物，未注入时明确显示缺失状态。 */
const adminVersion = typeof __ADMIN_APP_VERSION__ === 'undefined' ? '' : __ADMIN_APP_VERSION__.trim();

type Tab = { id: PageId; path: string };
const icons = {
  users: Users,
  accounts: ShieldCheck,
  groups: Settings2,
  audit: ClipboardList,
  analytics: BarChart3,
  analytics_events: AppWindow,
  analytics_tracking: ClipboardList,
  fitness_exercises: Dumbbell,
  fitness_templates: Layers,
  fitness_plans: CalendarDays,
};

/** 顶层错误边界隐藏异常内容并提供刷新入口，详细日志不包含业务响应。 */
class AdminErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  /** 渲染失败后切换为友好错误界面。 */
  static getDerivedStateFromError() {
    return { failed: true };
  }
  /** 记录错误堆栈，排除用户资料和表单字段。 */
  componentDidCatch(error: Error, _info: ErrorInfo) {
    reportError('render-admin', error);
  }
  /** 错误边界不会尝试继续展示不完整的业务数据。 */
  render() {
    return this.state.failed ? (
      <div className="session-screen">
        <h1>页面暂时无法显示</h1>
        <p>请刷新页面后重试。</p>
        <Button onClick={() => window.location.reload()}>刷新页面</Button>
      </div>
    ) : (
      this.props.children
    );
  }
}

/** 会话核对完成前只显示中性状态，认证终止时业务工作区整体卸载。 */
export function App() {
  const session = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (session.phase === 'anonymous' && location.pathname !== '/login') void navigate('/login', { replace: true });
    if (
      session.phase === 'authenticated' &&
      session.session &&
      (location.pathname === '/login' || location.pathname === '/')
    ) {
      void navigate(landingPath(session.session.admin), { replace: true });
    }
    if (session.phase === 'authenticated' && canonicalPath(location.pathname) !== location.pathname) {
      void navigate(`${canonicalPath(location.pathname)}${location.search}`, { replace: true });
    }
  }, [session.phase, session.session, location.pathname, location.search, navigate]);
  if (session.phase === 'checking')
    return (
      <div className="session-screen">
        <Loading label="正在核对后台会话…" />
      </div>
    );
  if (session.phase === 'anonymous') return <LoginPage />;
  if (session.phase === 'error' || session.phase === 'logout-error')
    return (
      <div className="session-screen">
        <h1>{session.phase === 'logout-error' ? '退出尚未完成' : '暂时无法连接管理后台'}</h1>
        <p role="alert">{session.message}</p>
        <Button
          variant="primary"
          onClick={() => void (session.phase === 'logout-error' ? session.logout() : session.verify())}
        >
          {session.phase === 'logout-error' ? '重试退出' : '重新核对会话'}
        </Button>
      </div>
    );
  return (
    <AdminErrorBoundary key={session.epoch}>
      <AdminShell />
    </AdminErrorBoundary>
  );
}

/** 业务页签保留各页面的组件状态；本人中心是左下账号信息触发的独立弹窗。 */
function AdminShell() {
  const session = useSession();
  const admin = session.session!.admin;
  const location = useLocation();
  const navigate = useNavigate();
  const allowed = (Object.keys(pageInfo) as PageId[]).filter((page) => canAccess(admin, page));
  const active = routePage(location.pathname);
  const currentPath = `${location.pathname}${location.search}`;
  const [tabs, setTabs] = useState<Tab[]>(() => {
    const first = active && allowed.includes(active) ? active : allowed[0];
    return first ? [{ id: first, path: active === first ? currentPath : pageInfo[first].path }] : [];
  });
  const [personal, setPersonal] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!active || !canAccess(admin, active)) return;
    setTabs((current) => {
      const permitted = current.filter((tab) => canAccess(admin, tab.id));
      const existing = permitted.find((tab) => tab.id === active);
      if (existing?.path === currentPath) return current;
      return existing
        ? permitted.map((tab) => (tab.id === active ? { ...tab, path: currentPath } : tab))
        : [...permitted, { id: active, path: currentPath }];
    });
  }, [active, currentPath, admin]);
  /** 已打开的导航恢复该页签最后的详情位置，不重复创建页签。 */
  function open(page: PageId) {
    setNavigationOpen(false);
    const tab = tabs.find((item) => item.id === page);
    void navigate(tab?.path || pageInfo[page].path);
  }
  /** 关闭当前页签激活相邻页，有业务权限时保留最后一页。 */
  function close(page: PageId) {
    if (tabs.length <= 1) return;
    const index = tabs.findIndex((tab) => tab.id === page);
    const remaining = tabs.filter((tab) => tab.id !== page);
    setTabs(remaining);
    if (active === page) void navigate(remaining[Math.min(index, remaining.length - 1)]!.path);
  }
  /** 页签方向键激活相邻项并同步键盘焦点。 */
  function tabKey(event: React.KeyboardEvent, index: number) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const tab = tabs[next];
    if (tab) {
      void navigate(tab.path);
      document.getElementById(`tab-${tab.id}`)?.focus();
    }
  }
  return (
    <div className="admin-shell">
      <aside className={`sidebar${navigationOpen ? ' sidebar-navigation-open' : ''}`}>
        <div className="brand">
          <Link
            className="brand-home"
            to={landingPath(admin)}
            onClick={() => setNavigationOpen(false)}
            aria-label="返回后台首页"
          >
            <img className="brand-mark" src="/app-logo.svg" alt="芝麻记 Logo" width={48} height={48} />
            <span>
              <strong>Sesame Notes</strong>
              <small>
                ADMIN{import.meta.env.VITE_ADMIN_ENV_LABEL ? ` · ${import.meta.env.VITE_ADMIN_ENV_LABEL}` : ''}
              </small>
            </span>
          </Link>
          <Button
            className="sidebar-mobile-toggle"
            aria-label="展开或收起后台导航"
            aria-expanded={navigationOpen}
            onClick={() => setNavigationOpen((value) => !value)}
          >
            <Menu size={18} />
          </Button>
        </div>
        <nav aria-label="管理后台导航">
          {[
            {
              id: 'analytics',
              label: '数据统计',
              pages: ['analytics', 'analytics_events', 'analytics_tracking'] as PageId[],
              icon: BarChart3,
            },
            { id: 'application', label: '应用管理', pages: ['users'] as PageId[], icon: AppWindow },
            {
              id: 'fitness',
              label: '健身管理',
              pages: ['fitness_exercises', 'fitness_templates', 'fitness_plans'] as PageId[],
              icon: Dumbbell,
            },
            { id: 'system', label: '系统管理', pages: ['accounts', 'groups', 'audit'] as PageId[], icon: Settings2 },
          ].map((group) => {
            const pages = group.pages.filter((page) => allowed.includes(page));
            if (!pages.length) return null;
            return (
              <section className="nav-group" key={group.id}>
                <button
                  type="button"
                  className="nav-group-title"
                  aria-expanded={!collapsed[group.id]}
                  onClick={() => setCollapsed({ ...collapsed, [group.id]: !collapsed[group.id] })}
                >
                  <group.icon size={16} />
                  <span>{group.label}</span>
                  {collapsed[group.id] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
                {!collapsed[group.id] && (
                  <div className="nav-children">
                    {pages.map((page) => {
                      const Icon = icons[page];
                      return (
                        <button
                          type="button"
                          key={page}
                          aria-current={page === active ? 'page' : undefined}
                          onClick={() => open(page)}
                        >
                          <Icon size={16} />
                          {pageInfo[page].title}
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <button
            type="button"
            className="profile-trigger"
            onClick={() => setPersonal(true)}
            aria-label={`${admin.display_name}，${admin.username}，打开个人中心`}
          >
            <span className="profile-avatar">{[...admin.display_name][0] || 'A'}</span>
            <span>
              <strong>{admin.display_name}</strong>
              <small>{admin.username}</small>
            </span>
          </button>
          <span className="app-version">{adminVersion ? `v${adminVersion}` : '版本未记录'}</span>
        </div>
      </aside>
      <div className="workspace">
        {!!tabs.length && (
          <div className="workspace-tabs" role="tablist" aria-label="工作区页签">
            {tabs.map((tab, index) => (
              <div className={`workspace-tab ${active === tab.id ? 'active' : ''}`} key={tab.id} role="presentation">
                <button
                  type="button"
                  id={`tab-${tab.id}`}
                  role="tab"
                  aria-selected={active === tab.id}
                  aria-controls={`panel-${tab.id}`}
                  onClick={() => void navigate(tab.path)}
                  onKeyDown={(event) => tabKey(event, index)}
                >
                  {pageInfo[tab.id].title}
                </button>
                <button
                  type="button"
                  aria-label={`关闭${pageInfo[tab.id].title}页签`}
                  disabled={tabs.length <= 1}
                  onClick={() => close(tab.id)}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <main>
          {!allowed.length ? (
            <PersonalCenter />
          ) : (!active || !allowed.includes(active)) && !['/login', '/'].includes(location.pathname) ? (
            <section className="page-content">
              <h1>当前账号无法访问此页面</h1>
              <Button onClick={() => open(allowed[0]!)}>返回可访问页面</Button>
            </section>
          ) : null}
          {tabs.map((tab) => {
            const path = tab.id === active ? currentPath : tab.path;
            const pathname = path.split('?')[0]!;
            let userId: string | undefined;
            try {
              if (tab.id === 'users' && pathname.startsWith('/application/users/'))
                userId = decodeURIComponent(pathname.slice('/application/users/'.length));
            } catch {
              userId = undefined;
            }
            return (
              <section
                key={tab.id}
                id={`panel-${tab.id}`}
                role="tabpanel"
                aria-labelledby={`tab-${tab.id}`}
                hidden={tab.id !== active}
                className="page-content"
              >
                {tab.id === 'users' ? (
                  <UsersPage active={tab.id === active} userId={userId} navigate={(next) => void navigate(next)} />
                ) : tab.id === 'accounts' ? (
                  <AccountsPage active={tab.id === active} />
                ) : tab.id === 'groups' ? (
                  <GroupsPage active={tab.id === active} />
                ) : tab.id === 'analytics' ? (
                  <AnalyticsOverview active={tab.id === active} navigate={(next) => void navigate(next)} />
                ) : tab.id === 'analytics_events' ? (
                  <EventAnalysis
                    active={tab.id === active}
                    path={path}
                    navigate={(next) => void navigate(next, { replace: true })}
                  />
                ) : tab.id === 'analytics_tracking' ? (
                  <TrackingManagement active={tab.id === active} />
                ) : tab.id === 'fitness_exercises' || tab.id === 'fitness_templates' || tab.id === 'fitness_plans' ? (
                  <FitnessManagementPage
                    active={tab.id === active}
                    kind={
                      tab.id === 'fitness_exercises' ? 'exercise' : tab.id === 'fitness_templates' ? 'template' : 'plan'
                    }
                  />
                ) : (
                  <AuditPage active={tab.id === active} />
                )}
              </section>
            );
          })}
        </main>
      </div>
      {personal && !!allowed.length && <PersonalCenter onClose={() => setPersonal(false)} />}
    </div>
  );
}
