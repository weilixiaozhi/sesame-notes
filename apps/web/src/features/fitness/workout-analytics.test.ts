import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductAnalyticsCollector } from '../../lib/product-analytics';
import { createAnalyticsFixture as setup } from '../../test/product-analytics-fixture';
import { WorkoutAnalyticsFlows } from './workout-analytics';

/** 测试通过通用上下文接口注入采集器，业务适配器不访问其内部状态。 */
function createFlows(collector: ProductAnalyticsCollector, options: ReturnType<typeof setup>['options']) {
  return new WorkoutAnalyticsFlows({
    storage: options.storage,
    storagePrefix: options.storagePrefix,
    now: options.now,
    captureContext: (context) => collector.captureContext(context, false),
    reportError: options.reportError,
  });
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('训练流程业务适配', () => {
  it('训练流程按本地记录独立保留，关闭重开可延续，未观察到开始的记录没有流程', async () => {
    const { collector, send, time, options } = setup();
    const flows = createFlows(collector, options);
    collector.setAccount('one');
    collector.enterPage('fitness', '/fitness');
    const first = collector.beginFlow()!;
    collector.trackAction('fitness_workout_started', 'fitness.workout', 'one', first);
    flows.remember('仅本地的训练业务身份', first);
    expect(flows.find('另一条记录')).toBeNull();
    time(options.now() + 3 * 3_600_000);
    const reopening = collector.captureContext(flows.find('仅本地的训练业务身份'))!;
    expect(reopening.flowId).toBe(first.flowId);
    expect(reopening.sessionId).not.toBe(first.sessionId);
    collector.trackAction('fitness_workout_completed', 'fitness.workout', 'one', reopening);
    const next = collector.beginFlow()!;
    flows.remember('仅本地的训练业务身份', next);
    flows.forget('仅本地的训练业务身份', first);
    expect(flows.find('仅本地的训练业务身份')?.flowId).toBe(next.flowId);
    flows.forget('仅本地的训练业务身份', next);
    expect(flows.find('仅本地的训练业务身份')).toBeNull();
    await collector.flush();
    expect(JSON.stringify(send.mock.calls[0]![1])).not.toContain('仅本地的训练业务身份');
    const completed = send.mock.calls[0]![1].find((event) => event.event_name === 'fitness_workout_completed')!;
    expect(completed.flow_id).toBe(first.flowId);
    expect(completed.session_id).not.toBe(first.sessionId);
  });
  it('训练随机流程跨运行恢复并重新绑定会话和代际，账号隔离且九十天过期', async () => {
    const { collector, options, send, time } = setup();
    const flows = createFlows(collector, options);
    collector.setAccount('one');
    collector.enterPage('fitness', '/fitness');
    const original = collector.beginFlow()!;
    flows.remember('workout-local-id', original);
    const reloaded = new ProductAnalyticsCollector(options);
    const reloadedFlows = createFlows(reloaded, options);
    reloaded.setAccount('two');
    expect(reloadedFlows.find('workout-local-id')).toBeNull();
    reloaded.setAccount('one');
    reloaded.enterPage('fitness', '/fitness');
    const restored = reloadedFlows.find('workout-local-id')!;
    expect(restored.flowId).toBe(original.flowId);
    expect(restored.sessionId).not.toBe(original.sessionId);
    expect(restored.owner).not.toBe(original.owner);
    reloaded.trackAction('fitness_workout_completed', 'fitness.workout', 'one', original);
    await reloaded.flush();
    expect(send.mock.calls[0]![1].filter((event) => event.kind === 'action')).toHaveLength(0);
    time(options.now() + 91 * 86_400_000);
    expect(reloadedFlows.find('workout-local-id')).toBeNull();
    const fresh = new ProductAnalyticsCollector(options);
    const freshFlows = createFlows(fresh, options);
    fresh.setAccount('one');
    expect(freshFlows.find('workout-local-id')).toBeNull();
  });
  it('旧标签页迟到完成不清除新标签页流程，完成后的共享清理不会被旧内存缓存复活', () => {
    const { collector, options, store } = setup();
    const flows = createFlows(collector, options);
    collector.setAccount('one');
    collector.enterPage('fitness', '/fitness');
    const old = collector.beginFlow()!;
    flows.remember('local-workout', old);
    const second = new ProductAnalyticsCollector(options);
    const secondFlows = createFlows(second, options);
    second.setAccount('one');
    second.enterPage('fitness', '/fitness');
    const current = second.beginFlow()!;
    secondFlows.remember('local-workout', current);
    flows.forget('local-workout', old);
    expect(secondFlows.find('local-workout')?.flowId).toBe(current.flowId);
    expect(flows.find('local-workout')?.flowId).toBe(current.flowId);
    secondFlows.forget('local-workout', current);
    expect(flows.find('local-workout')).toBeNull();
    expect([...store.keys()].some((key) => key.startsWith('test:training-flow:'))).toBe(false);
  });
});
