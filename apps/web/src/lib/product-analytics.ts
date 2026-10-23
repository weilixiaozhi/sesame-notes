import type { operations } from '@sesame-notes/api-client';

type AnalyticsEvent = operations['postAnalyticsEvents']['requestBody']['content']['application/json']['events'][number];

const PRODUCT_ANALYTICS_PAGES = [
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
] as const satisfies readonly NonNullable<AnalyticsEvent['page_id']>[];
export type ProductAnalyticsPage = (typeof PRODUCT_ANALYTICS_PAGES)[number];
type PageEventSegment<Page extends string> = Page extends `${infer Parent}.${infer Child}`
  ? `${Parent}_${PageEventSegment<Child>}`
  : Page;
type ProductAnalyticsPageView = `${PageEventSegment<ProductAnalyticsPage>}_view`;
const PRODUCT_ANALYTICS_ACTIONS = [
  'navigation_mode_select',
  'accounting_ledger_select',
  'accounting_transaction_create_click',
  'accounting_transaction_open_click',
  'accounting_transaction_save_click',
  'accounting_transaction_created',
  'accounting_transaction_updated',
  'accounting_transaction_deleted',
  'accounting_statistics_open_click',
  'accounting_categories_open_click',
  'fitness_tab_select',
  'fitness_space_select',
  'fitness_workout_create_click',
  'fitness_workout_open_click',
  'fitness_workout_save_click',
  'fitness_workout_created',
  'fitness_workout_updated',
  'fitness_workout_start_click',
  'fitness_workout_started',
  'fitness_workout_pause_click',
  'fitness_workout_paused',
  'fitness_workout_finish_click',
  'fitness_workout_completed',
  'fitness_template_save_click',
  'fitness_template_saved',
  'fitness_plan_save_click',
  'fitness_plan_saved',
  'fitness_template_add_click',
  'fitness_template_added',
  'fitness_plan_add_click',
  'fitness_plan_added',
  'memos_note_create_click',
  'memos_note_open_click',
  'memos_note_save_click',
  'memos_note_saved',
  'memos_note_created',
  'memos_note_deleted',
  'memos_book_select',
  'credentials_create_click',
  'credentials_open_click',
  'credentials_save_click',
  'credentials_saved',
  'credentials_created',
  'credentials_deleted',
  'credentials_book_select',
  'days_event_create_click',
  'days_event_open_click',
  'days_event_save_click',
  'days_event_saved',
  'days_event_created',
  'days_event_deleted',
  'days_book_select',
  'calendar_day_select',
  'calendar_section_open_click',
] as const satisfies readonly NonNullable<AnalyticsEvent['event_name']>[];
export type ProductAnalyticsAction = (typeof PRODUCT_ANALYTICS_ACTIONS)[number];
export type ProductAnalyticsEvent = Pick<
  AnalyticsEvent,
  'event_id' | 'event_sequence' | 'occurred_at' | 'kind' | 'session_id' | 'flow_id'
> & {
  page_id?: ProductAnalyticsPage;
  event_name?: ProductAnalyticsAction | ProductAnalyticsPageView;
  platform: 'web';
};
export type ProductAnalyticsContext = Readonly<{
  owner: symbol;
  accountId: string;
  generation: number;
  sessionId: string;
  flowId?: string;
}>;
type CollectorOptions = {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { keys: () => string[] };
  storagePrefix: string;
  now: () => number;
  uuid: () => string;
  isVisible: () => boolean;
  isOnline: () => boolean;
  send: (accountId: string, events: ProductAnalyticsEvent[], signal: AbortSignal) => Promise<void>;
  reportError: (error: unknown) => void;
};
const MAX_AGE_MS = 90 * 86_400_000;
const MAX_QUEUE_SIZE = 1000;
const SESSION_IDLE_MS = 30 * 60_000;
const MAX_EVENT_SEQUENCE = 2_147_483_647;
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** 页面访问事件统一使用下划线分隔的页面层级，并以 view 标识访问行为。 */
function pageViewEventName(page: ProductAnalyticsPage): ProductAnalyticsPageView {
  return `${page.replaceAll('.', '_')}_view` as ProductAnalyticsPageView;
}

/** 恢复时校验事件类型、页面上下文与事件标识的对应关系，损坏记录不能进入发送队列。 */
function hasValidEventIdentity(
  entry: Partial<ProductAnalyticsEvent>,
): entry is Partial<ProductAnalyticsEvent> & Pick<ProductAnalyticsEvent, 'kind'> {
  if (entry.page_id !== undefined && !PRODUCT_ANALYTICS_PAGES.includes(entry.page_id)) return false;
  if (entry.kind === 'active') return entry.event_name === undefined;
  if (!entry.page_id) return false;
  if (entry.kind === 'page_view') return entry.event_name === pageViewEventName(entry.page_id);
  return entry.kind === 'action' && (PRODUCT_ANALYTICS_ACTIONS as readonly string[]).includes(entry.event_name ?? '');
}

/** 上海自然日决定跨午夜的真实交互是否需要补一条活跃事件。 */
function shanghaiDate(timestamp: number): string {
  return new Date(timestamp + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 对已登录账号缓存有限的离线事件，切换账号同步废弃旧队列和在途请求。 */
export class ProductAnalyticsCollector {
  private readonly contextOwner = Symbol('统计运行上下文');
  private accountId: string | null = null;
  private queue: ProductAnalyticsEvent[] = [];
  private rootPage: ProductAnalyticsPage | undefined;
  private rootVisitKey: string | null = null;
  private visitedPage: ProductAnalyticsPage | null = null;
  private visitedSurface: symbol | string | null = null;
  private surfaces = new Map<
    symbol,
    { page: ProductAnalyticsPage; priority: number; context?: ProductAnalyticsContext | null }
  >();
  private sessionId: string | null = null;
  private eventSequence = 0;
  private lastInteraction = 0;
  private viewScheduled = false;
  private lastActivity = 0;
  private generation = 0;
  private pending: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private persistedIds = new Set<string>();

  /** 依赖由调用方提供，采集逻辑与页面重绘、网络客户端及实际浏览器存储分离。 */
  constructor(private readonly options: CollectorOptions) {}

  /** 保存队列时捕获存储配额或隐私模式错误，使用行为采集不能阻断正常业务。 */
  private persist(): void {
    if (!this.accountId) return;
    try {
      const prefix = `${this.options.storagePrefix}:${this.accountId}:`;
      const remaining = new Set(this.queue.map((event) => event.event_id));
      // 每个事件独立存储，另一个标签页新增的事件不会被本页整队列写入覆盖。
      for (const id of this.persistedIds) if (!remaining.has(id)) this.options.storage.removeItem(`${prefix}${id}`);
      for (const event of this.queue) this.options.storage.setItem(`${prefix}${event.event_id}`, JSON.stringify(event));
      this.persistedIds = remaining;
    } catch (error) {
      this.options.reportError(error);
    }
  }

  /** 严格恢复当前账号队列，拒绝损坏或过期的离线事件。 */
  private restore(): void {
    if (!this.accountId) return;
    try {
      const prefix = `${this.options.storagePrefix}:${this.accountId}:`;
      const restored: ProductAnalyticsEvent[] = [];
      for (const key of this.options.storage.keys().filter((entry) => entry.startsWith(prefix))) {
        this.persistedIds.add(key.slice(prefix.length));
        try {
          const value: unknown = JSON.parse(this.options.storage.getItem(key) ?? 'null');
          if (!value || typeof value !== 'object') continue;
          const entry = value as Partial<ProductAnalyticsEvent>;
          const timestamp = Date.parse(entry.occurred_at ?? '');
          if (
            typeof entry.event_id === 'string' &&
            key === `${prefix}${entry.event_id}` &&
            UUID_PATTERN.test(entry.event_id) &&
            typeof entry.session_id === 'string' &&
            UUID_PATTERN.test(entry.session_id) &&
            Number.isSafeInteger(entry.event_sequence) &&
            entry.event_sequence! > 0 &&
            entry.event_sequence! <= MAX_EVENT_SEQUENCE &&
            (entry.flow_id === undefined || (typeof entry.flow_id === 'string' && UUID_PATTERN.test(entry.flow_id))) &&
            entry.platform === 'web' &&
            hasValidEventIdentity(entry) &&
            timestamp >= this.options.now() - MAX_AGE_MS &&
            timestamp <= this.options.now() + 5 * 60_000
          ) {
            restored.push({
              event_id: entry.event_id,
              event_sequence: entry.event_sequence!,
              occurred_at: new Date(timestamp).toISOString(),
              kind: entry.kind,
              page_id: entry.page_id,
              ...(entry.event_name ? { event_name: entry.event_name } : {}),
              platform: 'web',
              session_id: entry.session_id,
              ...(entry.flow_id ? { flow_id: entry.flow_id } : {}),
            });
          }
        } catch (error) {
          this.options.reportError(error);
        }
      }
      this.queue = restored
        .sort((left, right) => left.occurred_at.localeCompare(right.occurred_at))
        .slice(-MAX_QUEUE_SIZE);
      this.persist();
    } catch (error) {
      this.queue = [];
      this.options.reportError(error);
    }
  }

  /** 账号代际是队列唯一归属；旧请求完成后不能消费新账号的队列。 */
  setAccount(accountId: string | null): void {
    if (accountId === this.accountId) return;
    this.generation++;
    this.pending?.abort();
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.persist();
    this.persistedIds.clear();
    this.accountId = accountId;
    this.rootPage = undefined;
    this.rootVisitKey = null;
    this.visitedPage = null;
    this.visitedSurface = null;
    this.surfaces.clear();
    this.sessionId = null;
    this.lastInteraction = 0;
    this.lastActivity = 0;
    this.attempt = 0;
    this.restore();
    this.schedule();
  }

  /** 应用层提供已解析的页面与访问身份，相同界面的渲染和筛选不增加浏览量。 */
  enterPage(page: ProductAnalyticsPage | undefined, visitKey: string): void {
    if (visitKey !== this.rootVisitKey) this.surfaces.clear();
    this.rootPage = page && PRODUCT_ANALYTICS_PAGES.includes(page) ? page : undefined;
    this.rootVisitKey = visitKey;
    this.scheduleView();
  }

  /** 固定子页面与弹窗使用独立生命周期标识，优先记录用户当前看见的最上层页面。 */
  showSurface(
    key: symbol,
    page: ProductAnalyticsPage,
    priority: number,
    context?: ProductAnalyticsContext | null,
  ): void {
    try {
      if (!PRODUCT_ANALYTICS_PAGES.includes(page)) return;
      this.surfaces.delete(key);
      this.surfaces.set(key, { page, priority, context });
      this.scheduleView();
    } catch (error) {
      this.options.reportError(error);
    }
  }

  /** 关闭详情后恢复仍挂载的子页面；同一次重绘中的卸载与挂载只结算最终页面。 */
  hideSurface(key: symbol): void {
    this.surfaces.delete(key);
    this.scheduleView();
  }

  /** 页面生命周期在微任务末尾结算，避免弹窗关闭和页签切换产生中间页面访问。 */
  private scheduleView(): void {
    if (this.viewScheduled) return;
    this.viewScheduled = true;
    queueMicrotask(() =>
      queueMicrotask(() => {
        this.viewScheduled = false;
        this.syncVisiblePage();
      }),
    );
  }

  /** 只读取固定页面标识；弹窗身份只用于本地去重，不进入上报正文。 */
  private syncVisiblePage(): void {
    try {
      if (!this.accountId || !this.options.isVisible() || !this.rootVisitKey || !this.rootPage) return;
      let page = this.rootPage;
      let identity: symbol | string = this.rootVisitKey;
      let priority = -1;
      let flow: ProductAnalyticsContext | null | undefined;
      for (const [key, surface] of this.surfaces) {
        if (surface.priority >= priority) {
          page = surface.page;
          identity = key;
          priority = surface.priority;
          flow = surface.context;
        }
      }
      if (page === this.visitedPage && identity === this.visitedSurface) return;
      this.visitedPage = page;
      this.visitedSurface = identity;
      this.enqueue('page_view', page, pageViewEventName(page), this.captureContext(flow));
    } catch (error) {
      this.options.reportError(error);
    }
  }

  /** 仅白名单业务动作进入队列，普通键鼠交互仍只承担活跃判断。 */
  trackAction(
    eventName: ProductAnalyticsAction,
    page?: ProductAnalyticsPage,
    expectedAccountId?: string,
    context?: ProductAnalyticsContext | null,
  ): void {
    try {
      this.syncVisiblePage();
      const sourcePage = page ?? this.visitedPage;
      // 异步完成沿用发起操作的固定账号；请求等待期间切到后台仍可确认真实业务结果。
      const completing =
        expectedAccountId !== undefined &&
        context != null &&
        /_(?:created|updated|saved|deleted|added|started|paused|completed)$/.test(eventName);
      if (
        !this.accountId ||
        context === null ||
        (expectedAccountId !== undefined && expectedAccountId !== this.accountId) ||
        (context !== undefined && context !== null && !this.contextCurrent(context)) ||
        (!this.options.isVisible() && !completing) ||
        !PRODUCT_ANALYTICS_ACTIONS.includes(eventName) ||
        !sourcePage ||
        !PRODUCT_ANALYTICS_PAGES.includes(sourcePage)
      )
        return;
      this.enqueue('action', sourcePage, eventName, context ?? this.captureContext(undefined, !completing));
    } catch (error) {
      this.options.reportError(error);
    }
  }

  /** 前台恢复与实际键鼠交互补活跃；没有真实交互的后台轮询不会产生记录。 */
  interact(): void {
    if (!this.accountId || !this.options.isVisible() || !this.rootVisitKey || !this.rootPage) return;
    this.captureContext();
    this.syncVisiblePage();
    const now = this.options.now();
    if (
      !this.lastActivity ||
      now - this.lastActivity >= 5 * 60_000 ||
      shanghaiDate(now) !== shanghaiDate(this.lastActivity)
    ) {
      this.enqueue('active', this.visitedPage ?? this.rootPage);
    }
    this.schedule();
  }

  /** 创建不可变事件标识，网络重传重复使用原标识，服务端据此去重。 */
  private enqueue(
    kind: ProductAnalyticsEvent['kind'],
    page: ProductAnalyticsEvent['page_id'],
    eventName?: ProductAnalyticsEvent['event_name'],
    context?: ProductAnalyticsContext | null,
  ): void {
    try {
      const now = this.options.now();
      const association = context ?? this.captureContext(undefined, false);
      if (!association || !this.contextCurrent(association)) {
        this.options.reportError(new Error('统计会话未能建立，本次事件未采集'));
        return;
      }
      if (this.eventSequence >= MAX_EVENT_SEQUENCE) throw new Error('统计事件序号超出允许范围，本次事件未采集');
      this.queue.push({
        event_id: this.options.uuid(),
        event_sequence: ++this.eventSequence,
        occurred_at: new Date(now).toISOString(),
        kind,
        page_id: page,
        ...(eventName ? { event_name: eventName } : {}),
        platform: 'web',
        session_id: association.sessionId,
        ...(association.flowId ? { flow_id: association.flowId } : {}),
      });
      this.queue = this.queue
        .filter((event) => Date.parse(event.occurred_at) >= now - MAX_AGE_MS)
        .slice(-MAX_QUEUE_SIZE);
      this.lastActivity = now;
      this.persist();
      this.schedule();
    } catch (error) {
      this.options.reportError(error);
    }
  }

  /** 关联上下文只属于当前账号代际，退出后重新登录同一账号也不能复用旧操作。 */
  private contextCurrent(context: ProductAnalyticsContext): boolean {
    return (
      context.owner === this.contextOwner &&
      context.accountId === this.accountId &&
      context.generation === this.generation &&
      UUID_PATTERN.test(context.sessionId) &&
      (context.flowId === undefined || UUID_PATTERN.test(context.flowId))
    );
  }

  /** 真实交互延续运行会话；离线补报和异步回包不延长三十分钟的交互窗口。 */
  captureContext(flow?: ProductAnalyticsContext | null, interacting = true): ProductAnalyticsContext | null {
    try {
      if (!this.accountId || (flow && !this.contextCurrent(flow))) return null;
      const now = this.options.now();
      if (!this.sessionId || (interacting && now - this.lastInteraction >= SESSION_IDLE_MS))
        this.sessionId = this.options.uuid();
      if (interacting) this.lastInteraction = now;
      return Object.freeze({
        owner: this.contextOwner,
        accountId: this.accountId,
        generation: this.generation,
        sessionId: this.sessionId,
        ...(flow?.flowId ? { flowId: flow.flowId } : {}),
      });
    } catch (error) {
      this.options.reportError(error);
      return null;
    }
  }

  /** 每次真实操作入口产生全新的随机流程身份，源页面的既有访问记录保持原样。 */
  beginFlow(): ProductAnalyticsContext | null {
    try {
      if (!this.options.isVisible()) return null;
      const context = this.captureContext();
      return context ? Object.freeze({ ...context, flowId: this.options.uuid() }) : null;
    } catch (error) {
      this.options.reportError(error);
      return null;
    }
  }

  /** 批量与退避发送控制请求数量；离线时等待联网事件唤醒。 */
  schedule(): void {
    if (!this.accountId || !this.queue.length || this.pending || this.timer || !this.options.isOnline()) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.flush();
      },
      Math.min(60_000, 1000 * 2 ** this.attempt),
    );
  }

  /** 发送前再次剔除过期记录；账号变化与请求取消都不能重放到别的身份。 */
  async flush(): Promise<void> {
    this.syncVisiblePage();
    if (!this.accountId || this.pending || !this.options.isOnline()) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const now = this.options.now();
    this.queue = this.queue.filter(
      (event) => Date.parse(event.occurred_at) >= now - MAX_AGE_MS && Date.parse(event.occurred_at) <= now + 5 * 60_000,
    );
    const batch = this.queue.slice(0, 100);
    this.persist();
    if (!batch.length) return;
    const expected = this.generation;
    const pending = new AbortController();
    this.pending = pending;
    try {
      await this.options.send(this.accountId, batch, pending.signal);
      if (expected !== this.generation) return;
      const sent = new Set(batch.map((event) => event.event_id));
      this.queue = this.queue.filter((event) => !sent.has(event.event_id));
      this.attempt = 0;
      this.persist();
    } catch (error) {
      if (expected !== this.generation || pending.signal.aborted) return;
      // 客户端版本不兼容或损坏批次不能永久堵塞队列；网络与限流错误保留原标识重试。
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
      if (status === 400 || status === 413) {
        const discarded = new Set(batch.map((event) => event.event_id));
        this.queue = this.queue.filter((event) => !discarded.has(event.event_id));
        this.persist();
      }
      this.attempt = Math.min(6, this.attempt + 1);
      this.options.reportError(error);
    } finally {
      if (expected === this.generation) {
        this.pending = null;
        this.schedule();
      }
    }
  }
}
