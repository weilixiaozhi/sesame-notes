const ANALYTICS_PAGE_NAMES = {
  home: '我的生活',
  accounting: '记账.首页',
  'accounting.transaction': '记账.交易详情',
  'accounting.transaction.editor': '记账.记一笔',
  'accounting.statistics': '记账.统计',
  'accounting.categories': '记账.分类管理',
  'accounting.aa_split.editor': '记账.编辑分摊',
  'accounting.aa_statistics': '记账.分摊统计',
  'accounting.member_statistics': '记账.成员支出',
  'accounting.ledgers.edit': '记账.账本编辑',
  'accounting.sharing': '记账.共享与成员',
  fitness: '健身.首页',
  'fitness.exercises': '健身.动作库',
  'fitness.exercise': '健身.动作详情',
  'fitness.templates': '健身.我的模板',
  'fitness.template': '健身.模板详情',
  'fitness.plans': '健身.训练计划',
  'fitness.plan': '健身.计划详情',
  'fitness.workouts': '健身.训练记录',
  'fitness.workout': '健身.训练详情',
  'fitness.statistics': '健身.训练统计',
  'fitness.calendar': '健身.训练日历',
  'fitness.templates.library': '健身.模板库',
  'fitness.templates.library.detail': '健身.官方模板详情',
  'fitness.plans.library.detail': '健身.官方计划详情',
  'fitness.library': '健身.官方内容库',
  'fitness.workouts.editor': '健身.训练记录编辑',
  memos: '备忘录.首页',
  'memos.detail': '备忘录.详情',
  'memos.editor': '备忘录.编辑',
  credentials: '账号密码.首页',
  'credentials.detail': '账号密码.详情',
  'credentials.editor': '账号密码.编辑',
  'credentials.books.edit': '账号密码.账号密码本编辑',
  days: '日子.首页',
  'days.detail': '日子.详情',
  'days.editor': '日子.编辑',
  'days.calendar': '日子.日历',
  calendar: '日历',
  settings: '设置',
  'settings.profile': '设置.个人资料',
  'accounting.categories.edit': '记账.分类编辑',
  'accounting.categories.templates.flat': '记账.一般分类模板',
  'accounting.categories.templates.hierarchical': '记账.多级分类模板',
  'accounting.categories.detail': '记账.分类详情',
  'accounting.aa_member.detail': '记账.AA 成员账单详情',
  'accounting.ledgers': '记账.账本管理',
  'accounting.ledgers.archived': '记账.归档账本',
  'accounting.ledgers.join': '记账.加入账本',
  'accounting.currency': '记账.币种设置',
  'accounting.exchange_rate': '记账.汇率设置',
  'accounting.recurring.editor': '记账.周期交易编辑',
  'fitness.spaces': '健身.健身空间管理',
  'fitness.spaces.edit': '健身.健身空间编辑',
  'fitness.exercises.edit': '健身.动作编辑',
  'fitness.templates.edit': '健身.模板编辑',
  'fitness.plans.library': '健身.计划库',
  'fitness.plans.edit': '健身.计划编辑',
  'memos.tools': '备忘录.工具',
  'memos.books': '备忘录.备忘录本管理',
  'memos.books.edit': '备忘录.备忘录本编辑',
  'days.tools': '日子.工具',
  'days.books': '日子.纪念日本管理',
  'days.books.edit': '日子.纪念日本编辑',
  'settings.profile.name': '设置.昵称',
  'settings.profile.avatar': '设置.头像',
  'settings.profile.gender': '设置.性别',
  'settings.reminder': '设置.提醒',
  'settings.language': '设置.语言',
  'settings.theme': '设置.主题',
  'settings.app_lock': '设置.应用锁',
  'settings.cloud': '设置.云服务',
  'settings.sync': '设置.同步',
} as const;
export const ANALYTICS_PAGE_IDS = Object.keys(ANALYTICS_PAGE_NAMES) as Array<keyof typeof ANALYTICS_PAGE_NAMES>;
const PAGE_LOCATIONS: Partial<Record<keyof typeof ANALYTICS_PAGE_NAMES, string>> = {
  home: 'Web：我的生活',
  'accounting.transaction': 'App：交易详情底部弹层；Web：支出详情',
  'accounting.transaction.editor': 'App：记一笔；Web：记一笔支出 / 编辑支出',
  'accounting.statistics': 'App：统计；Web：图表分析',
  'accounting.categories': 'App：分类管理；Web：支出分类',
  'accounting.aa_statistics': 'App：分摊统计；Web：AA 分摊与结算',
  'accounting.aa_split.editor': 'App：编辑分摊',
  'accounting.member_statistics': 'Web：成员支出',
  'accounting.sharing': 'Web：共享与成员',
  'fitness.templates': 'App / Web：我的模板',
  'fitness.plans': 'App：我的计划；Web：训练计划',
  'fitness.workouts.editor': 'Web：安排训练 / 编辑训练记录',
  'memos.editor': 'App：添加笔记 / 笔记正文编辑；Web：写一条备忘录 / 编辑备忘录',
  'credentials.editor': 'App：添加账号密码 / 编辑账号密码；Web：新建账号卡片 / 编辑账号卡片',
  'days.editor': 'App：添加纪念日 / 编辑纪念日；Web：添加一个重要日子 / 编辑日子',
  settings: 'App：我的；Web：设置',
};
type PageId = keyof typeof ANALYTICS_PAGE_NAMES;
type Platform = 'app' | 'web';
type Behavior = 'view' | 'click' | 'complete';
type AnalyticsDefinition = {
  id: string;
  event_name: string;
  page_id: string | null;
  kind: 'page_view' | 'action';
  behavior: Behavior;
  name: string;
  location: string;
  platforms: Platform[];
  source_pages: Array<{ page_id: PageId; platforms: Platform[] }>;
};
const ACTIONS = [
  ['navigation_mode_select', '切换业务模式', 'click'],
  ['navigation_tab_select', '切换主导航', 'click'],
  ['accounting_ledger_select', '切换账本', 'click'],
  ['accounting_transaction_create_click', '点击新增交易', 'click'],
  ['accounting_transaction_open_click', '打开交易', 'click'],
  ['accounting_transaction_edit_click', '点击编辑交易', 'click'],
  ['accounting_transaction_save_click', '点击保存交易', 'click'],
  ['accounting_transaction_created', '交易新建成功', 'complete'],
  ['accounting_transaction_updated', '交易更新成功', 'complete'],
  ['accounting_transaction_deleted', '交易删除成功', 'complete'],
  ['accounting_statistics_open_click', '打开记账统计', 'click'],
  ['accounting_categories_open_click', '打开交易分类', 'click'],
  ['fitness_tab_select', '切换训练页签', 'click'],
  ['fitness_space_select', '切换训练空间', 'click'],
  ['fitness_workout_create_click', '点击新增训练', 'click'],
  ['fitness_workout_open_click', '打开训练记录', 'click'],
  ['fitness_workout_save_click', '点击保存训练记录', 'click'],
  ['fitness_workout_created', '训练记录新建成功', 'complete'],
  ['fitness_workout_updated', '训练记录更新成功', 'complete'],
  ['fitness_workout_start_click', '点击开始训练', 'click'],
  ['fitness_workout_started', '训练开始成功', 'complete'],
  ['fitness_workout_pause_click', '点击暂停训练', 'click'],
  ['fitness_workout_paused', '训练暂停成功', 'complete'],
  ['fitness_workout_finish_click', '点击结束训练', 'click'],
  ['fitness_workout_completed', '训练完成成功', 'complete'],
  ['fitness_template_save_click', '点击保存训练模板', 'click'],
  ['fitness_template_saved', '训练模板保存成功', 'complete'],
  ['fitness_plan_save_click', '点击保存训练计划', 'click'],
  ['fitness_plan_saved', '训练计划保存成功', 'complete'],
  ['fitness_template_add_click', '添加官方模板', 'click'],
  ['fitness_template_added', '官方模板添加成功', 'complete'],
  ['fitness_plan_add_click', '添加官方计划', 'click'],
  ['fitness_plan_added', '官方计划添加成功', 'complete'],
  ['memos_note_create_click', '点击新增备忘录', 'click'],
  ['memos_note_open_click', '打开备忘录', 'click'],
  ['memos_note_save_click', '点击保存备忘录', 'click'],
  ['memos_note_saved', '已有备忘录编辑保存成功', 'complete'],
  ['memos_note_created', '备忘录新建成功', 'complete'],
  ['memos_note_deleted', '备忘录删除成功', 'complete'],
  ['memos_book_select', '切换备忘录本', 'click'],
  ['credentials_create_click', '点击新增账号密码', 'click'],
  ['credentials_open_click', '打开账号密码条目', 'click'],
  ['credentials_save_click', '点击保存账号密码', 'click'],
  ['credentials_saved', '已有账号密码编辑保存成功', 'complete'],
  ['credentials_created', '账号密码新建成功', 'complete'],
  ['credentials_deleted', '账号密码删除成功', 'complete'],
  ['credentials_book_select', '切换账号密码本', 'click'],
  ['days_event_create_click', '点击新增日子', 'click'],
  ['days_event_open_click', '打开日子', 'click'],
  ['days_event_save_click', '点击保存日子', 'click'],
  ['days_event_saved', '已有日子编辑保存成功', 'complete'],
  ['days_event_created', '日子新建成功', 'complete'],
  ['days_event_deleted', '日子删除成功', 'complete'],
  ['days_book_select', '切换日子本', 'click'],
  ['calendar_day_select', '选择日历日期', 'click'],
  ['calendar_section_open_click', '打开日历业务入口', 'click'],
  ['calendar_create_click', '点击日历新增', 'click'],
  ['settings_theme_changed', '主题设置成功', 'complete'],
  ['settings_language_changed', '语言设置成功', 'complete'],
  ['settings_app_lock_changed', '应用锁设置成功', 'complete'],
  ['settings_reminder_changed', '提醒设置成功', 'complete'],
] as const;
const FEATURE_NAMES: Record<string, string> = {
  home: '首页',
  navigation: '导航',
  accounting: '记账',
  fitness: '健身',
  memos: '备忘录',
  credentials: '账号密码',
  days: '日子',
  calendar: '日历',
  settings: '设置',
};
/** 页面访问事件以规范页面路径生成唯一标识，页面路径只作为发生位置使用。 */
function analyticsPageEventName(page: string): string {
  return `${page.replaceAll('.', '_')}_view`;
}

/** 页面名称按事件标识的下划线规则连接业务名称与访问行为。 */
function pageName(page: keyof typeof ANALYTICS_PAGE_NAMES): string {
  return `${ANALYTICS_PAGE_NAMES[page].replaceAll('.', '_')}_访问`;
}

/** 动作名称按事件标识的下划线规则连接业务、操作与行为，创建和已有记录编辑完成保持不同名称。 */
function actionName(event: string, label: string, behavior: Exclude<Behavior, 'view'>): string {
  const feature = FEATURE_NAMES[event.split('_')[0]!]!;
  const operations: Record<string, string> = {
    create_click: '新增',
    created: '新增',
    open_click: '打开',
    edit_click: '编辑',
    save_click: '保存',
    saved: '编辑保存',
    updated: '编辑保存',
    deleted: '删除',
    start_click: '开始',
    started: '开始',
    pause_click: '暂停',
    paused: '暂停',
    finish_click: '结束',
    completed: '结束',
    mode_select: '业务模式切换',
    tab_select: '页签切换',
    ledger_select: '账本选择',
    statistics_open_click: '统计打开',
    categories_open_click: '分类管理打开',
    space_select: '空间选择',
    template_save_click: '模板保存',
    template_saved: '模板保存',
    plan_save_click: '计划保存',
    plan_saved: '计划保存',
    template_add_click: '官方模板添加',
    template_added: '官方模板添加',
    plan_add_click: '官方计划添加',
    plan_added: '官方计划添加',
    day_select: '日期选择',
    section_open_click: '业务入口',
    theme_changed: '主题设置',
    language_changed: '语言设置',
    app_lock_changed: '应用锁设置',
    reminder_changed: '提醒设置',
  };
  const simple = event.replace(
    /^(memos_(note_)?|days_(event_)?|credentials_|navigation_|accounting_|fitness_|calendar_|settings_)/,
    '',
  );
  let operation = event.endsWith('_book_select') ? `${feature}本切换` : operations[simple];
  if (!operation) {
    const match = /^(accounting_transaction_|fitness_workout_)(.+)$/.exec(event);
    if (match) operation = `${match[1] === 'accounting_transaction_' ? '交易' : '训练记录'}_${operations[match[2]!]!}`;
  }
  return [feature, operation ?? label.replace(/^点击|成功$/g, ''), behavior === 'click' ? '点击' : '完成'].join('_');
}
const APP_PAGES = new Set<PageId>([
  'accounting',
  'accounting.aa_statistics',
  'accounting.aa_member.detail',
  'accounting.aa_split.editor',
  'accounting.categories',
  'accounting.categories.detail',
  'accounting.categories.edit',
  'accounting.categories.templates.flat',
  'accounting.categories.templates.hierarchical',
  'accounting.currency',
  'accounting.exchange_rate',
  'accounting.ledgers',
  'accounting.ledgers.archived',
  'accounting.ledgers.edit',
  'accounting.ledgers.join',
  'accounting.recurring.editor',
  'accounting.statistics',
  'accounting.transaction',
  'accounting.transaction.editor',
  'calendar',
  'credentials',
  'credentials.detail',
  'credentials.editor',
  'credentials.books.edit',
  'days',
  'days.books',
  'days.books.edit',
  'days.detail',
  'days.editor',
  'days.tools',
  'fitness',
  'fitness.exercise',
  'fitness.exercises',
  'fitness.exercises.edit',
  'fitness.plans',
  'fitness.plans.edit',
  'fitness.plans.library',
  'fitness.plans.library.detail',
  'fitness.workout',
  'fitness.spaces',
  'fitness.spaces.edit',
  'fitness.statistics',
  'fitness.template',
  'fitness.templates',
  'fitness.templates.edit',
  'fitness.templates.library',
  'fitness.templates.library.detail',
  'memos',
  'memos.books',
  'memos.books.edit',
  'memos.detail',
  'memos.editor',
  'memos.tools',
  'settings',
  'settings.app_lock',
  'settings.cloud',
  'settings.language',
  'settings.profile',
  'settings.profile.avatar',
  'settings.profile.gender',
  'settings.profile.name',
  'settings.reminder',
  'settings.sync',
  'settings.theme',
]);
const WEB_PAGES = new Set<PageId>([
  'home',
  'accounting',
  'fitness',
  'memos',
  'credentials',
  'days',
  'calendar',
  'settings',
  'accounting.transaction',
  'accounting.transaction.editor',
  'accounting.categories',
  'accounting.statistics',
  'accounting.aa_statistics',
  'accounting.member_statistics',
  'accounting.ledgers.edit',
  'accounting.sharing',
  'fitness.workouts',
  'fitness.calendar',
  'fitness.statistics',
  'fitness.templates',
  'fitness.plans',
  'fitness.library',
  'fitness.exercises',
  'fitness.workout',
  'fitness.workouts.editor',
  'memos.editor',
  'credentials.editor',
  'days.editor',
  'days.calendar',
  'days.tools',
  'days.books.edit',
  'memos.books.edit',
  'credentials.books.edit',
  'accounting.ledgers.join',
  'accounting.categories.edit',
  'accounting.categories.templates.flat',
  'accounting.categories.templates.hierarchical',
  'accounting.exchange_rate',
  'settings.profile.avatar',
  'fitness.spaces.edit',
  'fitness.template',
  'fitness.templates.edit',
  'fitness.templates.library.detail',
  'fitness.plans.library.detail',
  'fitness.plan',
  'fitness.plans.edit',
  'fitness.exercise',
  'fitness.exercises.edit',
]);

type ActionName = (typeof ACTIONS)[number][0];
const ACTION_SOURCES: Readonly<Record<ActionName, Partial<Record<Platform, readonly PageId[] | 'all'>>>> = {
  navigation_mode_select: {
    app: 'all',
    web: 'all',
  },
  navigation_tab_select: {
    app: 'all',
  },
  accounting_ledger_select: {
    app: ['accounting', 'accounting.statistics', 'accounting.ledgers'],
    web: ['accounting'],
  },
  accounting_transaction_create_click: {
    app: ['accounting', 'accounting.statistics', 'calendar'],
    web: ['accounting'],
  },
  accounting_transaction_open_click: {
    app: ['accounting', 'accounting.categories.detail'],
    web: ['accounting'],
  },
  accounting_transaction_edit_click: {
    app: ['accounting.transaction', 'accounting.categories.detail', 'calendar', 'settings.sync'],
  },
  accounting_transaction_save_click: {
    app: ['accounting.transaction.editor'],
    web: ['accounting.transaction.editor'],
  },
  accounting_transaction_created: {
    app: ['accounting.transaction.editor'],
    web: ['accounting.transaction.editor'],
  },
  accounting_transaction_updated: {
    app: ['accounting.transaction.editor'],
    web: ['accounting.transaction.editor'],
  },
  accounting_transaction_deleted: {
    app: ['accounting', 'accounting.transaction'],
    web: ['accounting'],
  },
  accounting_statistics_open_click: {
    web: ['accounting'],
  },
  accounting_categories_open_click: {
    web: ['accounting'],
  },
  fitness_tab_select: {
    web: [
      'fitness',
      'fitness.workouts',
      'fitness.calendar',
      'fitness.statistics',
      'fitness.templates',
      'fitness.plans',
      'fitness.library',
      'fitness.exercises',
    ],
  },
  fitness_space_select: {
    app: ['fitness', 'fitness.plans', 'fitness.statistics', 'fitness.spaces'],
    web: [
      'fitness',
      'fitness.workouts',
      'fitness.calendar',
      'fitness.statistics',
      'fitness.templates',
      'fitness.plans',
      'fitness.library',
      'fitness.exercises',
    ],
  },
  fitness_workout_create_click: {
    app: ['fitness', 'fitness.plans', 'fitness.statistics', 'calendar'],
    web: ['fitness', 'fitness.workouts', 'fitness.calendar', 'fitness.template'],
  },
  fitness_workout_open_click: {
    app: [
      'accounting',
      'accounting.statistics',
      'days',
      'days.tools',
      'memos',
      'memos.tools',
      'credentials',
      'fitness',
      'fitness.plans',
      'fitness.statistics',
      'calendar',
      'settings',
      'fitness.exercise',
      'settings.sync',
      'fitness.template',
      'fitness.workout',
    ],
    web: ['fitness.workouts', 'fitness.calendar', 'fitness.exercise', 'calendar'],
  },
  fitness_workout_save_click: {
    web: ['fitness.workouts.editor'],
  },
  fitness_workout_created: {
    app: ['fitness', 'fitness.plans', 'fitness.statistics', 'calendar'],
    web: ['fitness.workouts.editor'],
  },
  fitness_workout_updated: {
    web: ['fitness.workouts.editor'],
  },
  fitness_workout_start_click: {
    app: ['fitness.template', 'fitness.workout'],
    web: ['fitness.workout'],
  },
  fitness_workout_started: {
    app: ['fitness.template', 'fitness.workout'],
    web: ['fitness.workout'],
  },
  fitness_workout_pause_click: {
    app: ['fitness.workout'],
    web: ['fitness.workout'],
  },
  fitness_workout_paused: {
    app: ['fitness.workout'],
    web: ['fitness.workout'],
  },
  fitness_workout_finish_click: {
    app: ['fitness.workout'],
    web: ['fitness.workout'],
  },
  fitness_workout_completed: {
    app: ['fitness.workout'],
    web: ['fitness.workout'],
  },
  fitness_template_save_click: {
    app: ['fitness.template', 'fitness.templates.edit'],
    web: ['fitness.templates.edit'],
  },
  fitness_template_saved: {
    app: ['fitness.template', 'fitness.templates.edit'],
    web: ['fitness.templates.edit'],
  },
  fitness_plan_save_click: {
    app: ['fitness.plans.edit'],
    web: ['fitness.plans.edit'],
  },
  fitness_plan_saved: {
    app: ['fitness.plans.edit'],
    web: ['fitness.plans.edit'],
  },
  fitness_template_add_click: {
    app: ['fitness.templates.library.detail'],
    web: ['fitness.templates.library.detail'],
  },
  fitness_template_added: {
    app: ['fitness.templates.library.detail'],
    web: ['fitness.templates.library.detail'],
  },
  fitness_plan_add_click: {
    app: ['fitness.plans.library.detail'],
    web: ['fitness.plans.library.detail'],
  },
  fitness_plan_added: {
    app: ['fitness.plans.library.detail'],
    web: ['fitness.plans.library.detail'],
  },
  memos_note_create_click: {
    app: ['memos', 'memos.tools', 'calendar'],
    web: ['memos'],
  },
  memos_note_open_click: {
    app: ['memos', 'calendar', 'settings.sync'],
    web: ['memos', 'calendar'],
  },
  memos_note_save_click: {
    app: ['memos.editor'],
    web: ['memos.editor'],
  },
  memos_note_saved: {
    app: ['memos.editor'],
    web: ['memos.editor'],
  },
  memos_note_created: {
    app: ['memos.editor'],
    web: ['memos.editor'],
  },
  memos_note_deleted: {
    app: ['memos'],
    web: ['memos'],
  },
  memos_book_select: {
    app: ['memos', 'memos.tools', 'memos.books'],
    web: ['memos'],
  },
  credentials_create_click: {
    app: ['credentials', 'memos.tools', 'calendar'],
    web: ['credentials'],
  },
  credentials_open_click: {
    app: ['credentials', 'calendar', 'settings.sync'],
    web: ['credentials', 'calendar'],
  },
  credentials_save_click: {
    app: ['credentials.editor'],
    web: ['credentials.editor'],
  },
  credentials_saved: {
    app: ['credentials.editor'],
    web: ['credentials.editor'],
  },
  credentials_created: {
    app: ['credentials.editor'],
    web: ['credentials.editor'],
  },
  credentials_deleted: {
    app: ['credentials', 'credentials.detail'],
    web: ['credentials'],
  },
  credentials_book_select: {
    app: ['credentials', 'memos.books'],
    web: ['credentials'],
  },
  days_event_create_click: {
    app: ['days', 'days.tools', 'calendar'],
    web: ['days', 'days.calendar'],
  },
  days_event_open_click: {
    app: ['days', 'calendar'],
    web: ['days', 'days.calendar', 'calendar'],
  },
  days_event_save_click: {
    app: ['days.editor'],
    web: ['days.editor'],
  },
  days_event_saved: {
    app: ['days.editor'],
    web: ['days.editor'],
  },
  days_event_created: {
    app: ['days.editor'],
    web: ['days.editor'],
  },
  days_event_deleted: {
    app: ['days', 'days.detail', 'calendar'],
    web: ['days'],
  },
  days_book_select: {
    app: ['days', 'days.tools', 'days.books'],
    web: ['days'],
  },
  calendar_day_select: {
    app: ['calendar'],
    web: ['calendar'],
  },
  calendar_section_open_click: {
    web: ['calendar'],
  },
  calendar_create_click: {
    app: ['calendar'],
  },
  settings_theme_changed: {
    app: ['settings.theme'],
  },
  settings_language_changed: {
    app: ['settings.language'],
  },
  settings_app_lock_changed: {
    app: ['settings.app_lock'],
  },
  settings_reminder_changed: {
    app: ['settings.reminder'],
  },
};

/** 发生页面是动作来源的唯一声明，目录展示与采集校验都由同一声明派生。 */
function actionSources(event: ActionName): AnalyticsDefinition['source_pages'] {
  const sources = new Map<PageId, Platform[]>();
  for (const platform of ['app', 'web'] as const) {
    const declared = ACTION_SOURCES[event][platform] ?? [];
    const pages = declared === 'all' ? (platform === 'app' ? APP_PAGES : WEB_PAGES) : declared;
    for (const page_id of pages) sources.set(page_id, [...(sources.get(page_id) ?? []), platform]);
  }
  return [...sources].map(([page_id, platforms]) => ({ page_id, platforms }));
}

/** 目录来源只列真实页面已实现采集的客户端。 */
function pagePlatforms(page: PageId): Platform[] {
  return [...(APP_PAGES.has(page) ? ['app' as const] : []), ...(WEB_PAGES.has(page) ? ['web' as const] : [])];
}

/** 按实际业务控件给出位置，便于查找已有埋点并避免在同一入口重复采集。 */
function actionLocation(event: string): string {
  if (event.startsWith('navigation_')) return event.includes('tab') ? '主导航栏的页签入口' : '主导航及首页业务模式入口';
  if (event === 'calendar_day_select') return '日历页面的日期格';
  if (event === 'calendar_section_open_click') return '日历页面的本子、训练日历及当天账目入口';
  if (event === 'calendar_create_click') return '日历页面的新增入口';
  if (event.startsWith('settings_'))
    return `设置页面的${event.includes('theme') ? '主题' : event.includes('language') ? '语言' : event.includes('app_lock') ? '应用锁' : '提醒'}选项`;
  if (event === 'accounting_ledger_select') return '记账页面及账本管理的账本选择控件';
  if (event === 'accounting_statistics_open_click') return '记账首页的统计入口';
  if (event === 'accounting_categories_open_click') return '记账首页的分类管理入口';
  if (event.startsWith('accounting_transaction_'))
    return event.includes('create_click')
      ? '记账页面或日历的新增交易入口'
      : event.includes('open_click')
        ? '交易列表的条目入口'
        : event.includes('edit_click')
          ? '交易详情的编辑按钮'
          : event.includes('deleted')
            ? '交易详情的删除按钮'
            : '记一笔页面的保存入口';
  if (event === 'fitness_tab_select') return '健身首页的业务页签';
  if (event === 'fitness_space_select') return '健身页面及空间管理的健身空间选择控件';
  if (event.startsWith('fitness_workout_'))
    return event.includes('create_click')
      ? '训练列表、日历或模板的新增入口'
      : event.includes('open')
        ? '训练记录条目与当前训练入口'
        : event.includes('save') || event.includes('updated') || event.includes('created')
          ? '训练记录新增或编辑器的保存入口'
          : event.includes('start')
            ? '训练模板或训练详情的开始按钮'
            : event.includes('pause')
              ? '训练详情的暂停按钮'
              : '训练详情的结束按钮';
  if (event.startsWith('fitness_template_add')) return '官方模板详情的添加入口';
  if (event.startsWith('fitness_plan_add')) return '官方计划详情的添加入口';
  if (event.startsWith('fitness_template_')) return '训练模板详情或编辑页面的保存入口';
  if (event.startsWith('fitness_plan_')) return '训练计划编辑器的保存入口';
  const business = event.startsWith('memos_') ? '备忘录' : event.startsWith('credentials_') ? '账号密码' : '日子';
  return event.includes('book_select')
    ? `${business}本选择控件`
    : event.includes('create_click')
      ? `${business}新增入口`
      : event.includes('open_click')
        ? `${business}条目的打开入口`
        : event.includes('deleted')
          ? `${business}条目的删除入口`
          : `${business}编辑器的保存入口`;
}

export const ANALYTICS_DEFINITIONS: AnalyticsDefinition[] = [
  ...ANALYTICS_PAGE_IDS.map((page_id): AnalyticsDefinition => ({
    id: analyticsPageEventName(page_id),
    page_id,
    event_name: analyticsPageEventName(page_id),
    kind: 'page_view',
    behavior: 'view',
    name: pageName(page_id),
    location: PAGE_LOCATIONS[page_id] ?? ANALYTICS_PAGE_NAMES[page_id].replaceAll('.', ' / '),
    platforms: pagePlatforms(page_id),
    source_pages: [],
  })),
  ...ACTIONS.map(([event_name, name, behavior]): AnalyticsDefinition => {
    const source_pages = actionSources(event_name);
    return {
      id: event_name,
      page_id: null,
      event_name,
      kind: 'action',
      behavior,
      name: actionName(event_name, name, behavior),
      location: actionLocation(event_name),
      platforms: (['app', 'web'] as const).filter((platform) =>
        source_pages.some((source) => source.platforms.includes(platform)),
      ),
      source_pages,
    };
  }),
];
export const ANALYTICS_DEFINITION_MAP = new Map(ANALYTICS_DEFINITIONS.map((definition) => [definition.id, definition]));
export const ANALYTICS_EVENT_NAMES = ANALYTICS_DEFINITIONS.map((definition) => definition.event_name);
export const ANALYTICS_PAGE_DEFINITION_MAP = new Map(
  ANALYTICS_DEFINITIONS.filter((definition) => definition.kind === 'page_view').map((definition) => [
    definition.page_id!,
    definition,
  ]),
);
