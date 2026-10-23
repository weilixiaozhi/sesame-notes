import { captureProductAnalyticsContext, type ProductAnalyticsContext } from '../../lib/product-analytics-runtime';

type WorkoutFlowOptions = {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  storagePrefix: string;
  now: () => number;
  captureContext: (parent?: ProductAnalyticsContext | null) => ProductAnalyticsContext | null;
  reportError: (error: unknown) => void;
};
const MAX_AGE_MS = 90 * 86_400_000;
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** 训练身份只用于本地索引，队列和网络层只接触随机流程上下文。 */
export class WorkoutAnalyticsFlows {
  private identity: ProductAnalyticsContext | null = null;
  private flows = new Map<string, ProductAnalyticsContext>();
  private times = new Map<string, number>();
  private persisted = new Set<string>();

  /** 业务存储依赖由适配器注入，训练关联不依赖 React、网络或采集器内部实现。 */
  constructor(private readonly options: WorkoutFlowOptions) {}

  /** 账号或运行代次变化时清除内存索引，持久数据仍按账号独立寻址。 */
  private current(): ProductAnalyticsContext | null {
    const current = this.options.captureContext();
    if (
      current?.owner !== this.identity?.owner ||
      current?.accountId !== this.identity?.accountId ||
      current?.generation !== this.identity?.generation
    ) {
      this.flows.clear();
      this.times.clear();
      this.persisted.clear();
    }
    this.identity = current;
    return current;
  }

  /** 只有真实开始的当前账号操作可登记；同一流程重登不会延长保留期限。 */
  remember(localKey: string, context: ProductAnalyticsContext | null): void {
    if (!this.current() || !context?.flowId || !this.options.captureContext(context)) return;
    const previous = this.flows.get(localKey);
    const createdAt =
      previous?.flowId === context.flowId ? (this.times.get(localKey) ?? this.options.now()) : this.options.now();
    this.flows.set(localKey, context);
    this.times.set(localKey, createdAt);
    try {
      this.options.storage.setItem(
        this.storageKey(localKey),
        JSON.stringify({ flow_id: context.flowId, created_at: new Date(createdAt).toISOString() }),
      );
      this.persisted.add(localKey);
    } catch (error) {
      this.persisted.delete(localKey);
      this.options.reportError(error);
    }
  }

  /** 共享存储为已落盘索引的权威来源，其他页清理后不会被本页内存复活。 */
  find(localKey: string, expectedAccountId?: string): ProductAnalyticsContext | null {
    const current = this.current();
    if (!current || (expectedAccountId !== undefined && current.accountId !== expectedAccountId)) return null;
    const memory = this.flows.get(localKey);
    if (
      memory &&
      !this.persisted.has(localKey) &&
      this.options.captureContext(memory) &&
      (this.times.get(localKey) ?? 0) >= this.options.now() - MAX_AGE_MS
    )
      return memory;
    try {
      const key = this.storageKey(localKey);
      const raw = this.options.storage.getItem(key);
      if (raw) {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== 'object') return null;
        const entry = value as { flow_id?: unknown; created_at?: unknown };
        const createdAt = typeof entry.created_at === 'string' ? Date.parse(entry.created_at) : NaN;
        if (
          typeof entry.flow_id !== 'string' ||
          !UUID_PATTERN.test(entry.flow_id) ||
          !Number.isFinite(createdAt) ||
          createdAt < this.options.now() - MAX_AGE_MS ||
          createdAt > this.options.now() + 5 * 60_000
        ) {
          this.options.storage.removeItem(key);
          this.forgetMemory(localKey);
          return null;
        }
        const context = Object.freeze({ ...current, flowId: entry.flow_id });
        this.flows.set(localKey, context);
        this.times.set(localKey, createdAt);
        this.persisted.add(localKey);
        return context;
      }
      this.forgetMemory(localKey);
      return null;
    } catch (error) {
      this.options.reportError(error);
    }
    const fallback = this.flows.get(localKey);
    return fallback &&
      this.options.captureContext(fallback) &&
      (this.times.get(localKey) ?? 0) >= this.options.now() - MAX_AGE_MS
      ? fallback
      : null;
  }

  /** 完成回执只清理原流程，迟到回执和其他标签页的新流程互不影响。 */
  forget(localKey: string, context: ProductAnalyticsContext | null): void {
    if (
      !this.current() ||
      !context ||
      !this.options.captureContext(context) ||
      this.find(localKey)?.flowId !== context.flowId
    )
      return;
    this.forgetMemory(localKey);
    try {
      const key = this.storageKey(localKey);
      const raw = this.options.storage.getItem(key);
      const stored: unknown = raw ? JSON.parse(raw) : null;
      if (stored && typeof stored === 'object' && 'flow_id' in stored && stored.flow_id === context.flowId)
        this.options.storage.removeItem(key);
    } catch (error) {
      this.options.reportError(error);
    }
  }

  /** 内存快照、首次观测时间和落盘状态共同释放，避免残留半份关联。 */
  private forgetMemory(localKey: string): void {
    this.flows.delete(localKey);
    this.times.delete(localKey);
    this.persisted.delete(localKey);
  }

  /** 业务记录身份仅进入本地账号隔离键，不写入埋点正文。 */
  private storageKey(localKey: string): string {
    return `${this.options.storagePrefix}:training-flow:${this.identity!.accountId}:${encodeURIComponent(localKey)}`;
  }
}

const trainingFlows = new WorkoutAnalyticsFlows({
  storage: {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: (key) => localStorage.removeItem(key),
  },
  storagePrefix: 'sesame-product-analytics',
  now: () => Date.now(),
  captureContext: (context) => captureProductAnalyticsContext(context, false),
  reportError: (error) => console.warn('[使用统计] 训练关联暂不可用', error),
});

/** 真实训练开始后保存关联，页面关闭不会提前终止训练流程。 */
export function rememberProductTrainingFlow(key: string, context: ProductAnalyticsContext | null): void {
  try {
    trainingFlows.remember(key, context);
  } catch (error) {
    console.warn('[使用统计] 训练关联暂不可用', error);
  }
}

/** 未观察到真实开始的训练保持无流程，重开已有训练沿用随机关联。 */
export function productTrainingFlow(key: string, expectedAccountId?: string): ProductAnalyticsContext | null {
  try {
    return trainingFlows.find(key, expectedAccountId);
  } catch (error) {
    console.warn('[使用统计] 训练关联暂不可用', error);
    return null;
  }
}

/** 只有当前训练流程的确认完成才释放对应关联。 */
export function forgetProductTrainingFlow(key: string, context: ProductAnalyticsContext | null): void {
  try {
    trainingFlows.forget(key, context);
  } catch (error) {
    console.warn('[使用统计] 训练关联暂不可用', error);
  }
}
