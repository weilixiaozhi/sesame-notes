import { Component, Suspense, lazy, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  BookOpen,
  CalendarHeart,
  CalendarDays,
  Dumbbell,
  House,
  LockKeyhole,
  NotebookPen,
  UserRound,
} from 'lucide-react';
import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { unwrap } from '@sesame-notes/api-client';
import { Button, ErrorState, LoadingState, PageHeading } from './components/ui';
import { AppLogo } from './components/app-logo';
import { api, useSession } from './lib/session';
import { useRealtime } from './lib/realtime';
import { useProductAnalytics } from './lib/use-product-analytics';
import { trackProductAction } from './lib/product-analytics-runtime';
import { analyticsPage } from './app-analytics';
import { LoginPage } from './features/auth/login-page';

/** 版本来自当前页面构建产物，未注入时明确显示缺失状态。 */
const webVersion = typeof __WEB_APP_VERSION__ === 'undefined' ? '' : __WEB_APP_VERSION__.trim();

const AccountingPage = lazy(() =>
  import('./features/accounting/accounting-page').then((module) => ({ default: module.AccountingPage })),
);
const MemosPage = lazy(() => import('./features/memos/memos-page').then((module) => ({ default: module.MemosPage })));
const DaysPage = lazy(() => import('./features/days/days-page').then((module) => ({ default: module.DaysPage })));
const FitnessPage = lazy(() =>
  import('./features/fitness/fitness-page').then((module) => ({ default: module.FitnessPage })),
);
const SettingsPage = lazy(() =>
  import('./features/settings/settings-page').then((module) => ({ default: module.SettingsPage })),
);
const CalendarPage = lazy(() =>
  import('./features/calendar/calendar-page').then((module) => ({ default: module.CalendarPage })),
);
const navigation = [
  { path: '/', label: '我的生活', mobileLabel: '生活', icon: House },
  { path: '/accounting', label: '记账', icon: BookOpen },
  { path: '/days', label: '日子', icon: CalendarHeart },
  { path: '/memos', label: '备忘录', icon: NotebookPen },
  { path: '/credentials', label: '账号密码', icon: LockKeyhole },
  { path: '/fitness', label: '健身', icon: Dumbbell },
];

/** 主导航和首页入口记录实际来源页面，目标页面由导航完成后的访问事件表示。 */
function trackNavigation(path: string): void {
  try {
    const page = analyticsPage(path);
    if (page) trackProductAction('navigation_mode_select');
  } catch (error) {
    console.warn('[使用统计] 导航记录暂不可用', error);
  }
}

/** 路由错误边界提供恢复入口，不展示内部堆栈或敏感内容。 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="fatal-error">
        <h1>页面暂时无法显示</h1>
        <p>请重新加载后再试。尚未保存的输入可能需要重新填写。</p>
        <Button onClick={() => window.location.reload()}>重新加载</Button>
      </main>
    ) : (
      this.props.children
    );
  }
}

/** 登录恢复与真正未登录分别处理，避免网络故障被当作退出。 */
export function App() {
  const { session, status, error, retry } = useSession();
  const location = useLocation();
  useProductAnalytics(session?.user.user_id ?? null, analyticsPage(location.pathname), location.pathname);
  if (status === 'loading')
    return (
      <div className="initial-loading">
        <AppLogo />
        <LoadingState label="正在连接…" />
      </div>
    );
  if (status === 'error')
    return (
      <main className="fatal-error">
        <h1>暂时无法连接</h1>
        <ErrorState error={error} retry={() => void retry()} />
      </main>
    );
  if (!session) return <LoginPage />;
  return (
    <Suspense fallback={<LoadingState label="正在打开页面…" />}>
      <Routes location={location}>
        <Route element={<AppShell key={session.user.user_id} />}>
          <Route index element={<OverviewPage />} />
          <Route path="accounting" element={<AccountingPage />} />
          <Route path="fitness" element={<FitnessPage />} />
          <Route path="memos" element={<MemosPage key="normal" />} />
          <Route path="credentials" element={<MemosPage key="credentials" />} />
          <Route path="days" element={<DaysPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

/** 桌面顶栏与手机底栏共用导航，让记录内容占据页面的主要空间。 */
function AppShell() {
  const { session } = useSession();
  const { online } = useRealtime(session!.user.user_id);
  const profile = useQuery({
    queryKey: ['account', session!.user.user_id, 'profile'],
    queryFn: async ({ signal }) => unwrap(await api.GET('/api/v1/profile/me', { signal })),
  });
  const name = profile.data?.display_name ?? session!.user.display_name ?? '芝麻记用户';
  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        跳到主要内容
      </a>
      <div className="app-workspace">
        <header className="topbar">
          <div className="topbar-inner">
            <Link className="brand" to="/" aria-label="芝麻记，我的生活" onClick={() => trackNavigation('/')}>
              <AppLogo decorative />
              <span>
                芝麻记<small>记录生活的点滴</small>
              </span>
            </Link>
            <nav className="desktop-nav" aria-label="主导航">
              {navigation.map((item) => (
                <NavLink key={item.path} to={item.path} end onClick={() => trackNavigation(item.path)}>
                  <item.icon size={17} />
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </nav>
            <div className="topbar-actions">
              <NavLink
                className="calendar-top-link"
                to="/calendar"
                aria-label="打开生活日历"
                onClick={() => trackNavigation('/calendar')}
              >
                <CalendarDays size={18} />
                <span>日历</span>
              </NavLink>
              <Link
                to="/settings"
                className="account-link"
                aria-label={`账号与设置，${name}`}
                onClick={() => trackNavigation('/settings')}
              >
                <span className="avatar">
                  <UserRound size={17} />
                </span>
                <span>{name}</span>
              </Link>
            </div>
          </div>
        </header>
        {!online && (
          <div role="status" className="offline-banner">
            网络已断开。当前内容可能不是最新；联网后将自动刷新，请保持编辑页面以保留输入。
          </div>
        )}
        <main id="main-content" className="main-content">
          <Suspense fallback={<LoadingState label="正在打开页面…" />}>
            <Outlet />
          </Suspense>
        </main>
        <footer className="app-footer">
          <span className="app-version">{webVersion ? `v${webVersion}` : '版本未记录'}</span>
        </footer>
      </div>
      <nav className="mobile-nav" aria-label="手机主导航">
        {navigation.map((item) => (
          <NavLink key={item.path} to={item.path} end onClick={() => trackNavigation(item.path)}>
            <item.icon size={21} />
            <span>{item.mobileLabel ?? item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

/** 首页按生活场景提供入口，仅把完整获取的本子数量作为辅助信息。 */
function OverviewPage() {
  const { session } = useSession();
  const collections = useQuery({
    queryKey: ['account', session!.user.user_id, 'overview'],
    queryFn: async ({ signal }) => {
      try {
        const [ledgers, memos, days, fitness] = await Promise.all([
          api.GET('/api/v1/ledgers', { signal }).then(unwrap),
          api.GET('/api/v1/sync/memo-books', { signal }).then(unwrap),
          api.GET('/api/v1/sync/day-books', { signal }).then(unwrap),
          api.GET('/api/v1/sync/fitness-spaces', { signal }).then(unwrap),
        ]);
        return {
          ledgers: ledgers.length,
          memos: memos.memo_books.filter((book) => book.type === 'normal').length,
          credentials: memos.memo_books.filter((book) => book.type === 'credentials').length,
          days: days.day_books.length,
          fitness: fitness.fitness_spaces.length,
        };
      } catch (error) {
        if (!signal.aborted) console.error('[生活首页] 读取记录本概况失败', error);
        throw error;
      }
    },
  });
  const cards = [
    {
      path: '/accounting',
      icon: BookOpen,
      label: '记账',
      description: '每一笔花销，都有迹可循。',
      action: '翻开我的账本',
      count: collections.data?.ledgers,
      unit: '本账本',
      tone: 'blue',
    },
    {
      path: '/days',
      icon: CalendarHeart,
      label: '日子',
      description: '让重要的日子，值得期待。',
      action: '看看重要日子',
      count: collections.data?.days,
      unit: '本日子本',
      tone: 'rose',
    },
    {
      path: '/memos',
      icon: NotebookPen,
      label: '备忘录',
      description: '安放想法，也留住灵感。',
      action: '翻开我的笔记',
      count: collections.data?.memos,
      unit: '本备忘录',
      tone: 'amber',
    },
    {
      path: '/credentials',
      icon: LockKeyhole,
      label: '账号密码',
      description: '常用账号，按卡片清楚整理。',
      action: '查看账号卡片',
      count: collections.data?.credentials,
      unit: '本账号密码',
      tone: 'green',
    },
    {
      path: '/fitness',
      icon: Dumbbell,
      label: '健身',
      description: '看见每一次坚持和进步。',
      action: '查看训练记录',
      count: collections.data?.fitness,
      unit: '个健身空间',
      tone: 'green',
    },
  ];
  return (
    <div className="stack overview">
      <PageHeading
        eyebrow={new Intl.DateTimeFormat('zh-CN', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          weekday: 'long',
        }).format(new Date())}
        title="我的生活"
        description="收支、想法、运动和期待，都在这里慢慢积累。"
      />
      <Link to="/calendar" className="overview-calendar" onClick={() => trackNavigation('/calendar')}>
        <span className="overview-calendar-date" aria-hidden="true">
          <span>{new Date().getMonth() + 1} 月</span>
          <strong>{new Date().getDate()}</strong>
        </span>
        <div>
          <span className="eyebrow">生活日历</span>
          <h2>从今天，看看生活的全貌</h2>
          <p>把每天的记录串在一起，回顾日常，也记得期待。</p>
        </div>
        <span className="overview-calendar-action">
          打开日历 <ArrowRight size={18} />
        </span>
      </Link>
      {collections.isError && <ErrorState error={collections.error} retry={() => void collections.refetch()} />}
      <div className="section-heading overview-section-heading">
        <h2>我的记录</h2>
        <span>让点滴积累，清晰可见</span>
      </div>
      <div className="overview-grid">
        {cards.map((card) => (
          <Link
            to={card.path}
            className={`overview-card tone-${card.tone}`}
            key={card.path}
            onClick={() => trackNavigation(card.path)}
          >
            <div className="overview-card-top">
              <span className="module-icon">
                <card.icon size={24} strokeWidth={1.6} />
              </span>
              <span className="overview-count">
                {collections.isPending
                  ? '正在读取…'
                  : card.count === undefined
                    ? '暂未读取'
                    : `${card.count} ${card.unit}`}
              </span>
            </div>
            <h2>{card.label}</h2>
            <p className="overview-card-description">{card.description}</p>
            <div className="overview-card-bottom">
              <span>{card.action}</span>
              <ArrowRight size={17} />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

/** 无效深链接提供可回到主界面的明确入口。 */
function NotFound() {
  return (
    <div className="empty-state">
      <h1>没有找到这个页面</h1>
      <p>链接可能已变更，你可以从导航继续访问记录。</p>
      <Link to="/" className="button button-primary">
        返回我的生活
      </Link>
    </div>
  );
}
