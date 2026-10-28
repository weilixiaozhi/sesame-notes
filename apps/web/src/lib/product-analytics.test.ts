import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductAnalyticsCollector } from './product-analytics';
import { createAnalyticsFixture as setup } from '../test/product-analytics-fixture';

/** 同一轮页面登记先完成结算，再模拟下一次真实导航或时间变化。 */
async function settlePage(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('产品 Web 使用采集', () => {
  it.each([
    ['accounting', 'accounting_view'],
    ['accounting.transaction.editor', 'accounting_transaction_editor_view'],
    ['accounting.aa_statistics', 'accounting_aa_statistics_view'],
    ['fitness.templates.library.detail', 'fitness_templates_library_detail_view'],
  ] as const)('页面 %s 使用独立的访问事件标识 %s，页面上下文保持不变', async (page, eventName) => {
    const { collector, send } = setup();
    collector.setAccount('one');
    collector.enterPage(page, '/current-page');
    await collector.flush();
    expect(send.mock.calls[0]![1]).toEqual([
      expect.objectContaining({ kind: 'page_view', page_id: page, event_name: eventName }),
    ]);
  });

  it('同毫秒事件按实际入队递增，离线恢复与重试保留原序号，切换账号使用新会话', async () => {
    const { collector, options, store, send } = setup();
    collector.setAccount('one');
    collector.enterPage('memos', '/memos');
    const context = collector.beginFlow();
    collector.trackAction('memos_note_create_click', undefined, 'one', context);
    collector.showSurface(Symbol('编辑器'), 'memos.editor', 2, context);
    await settlePage();
    collector.trackAction('memos_note_created', 'memos.editor', 'one', context);
    send.mockRejectedValueOnce(new Error('暂时离线'));
    await collector.flush();
    const first = send.mock.calls[0]![1];
    expect(first.map((event) => event.event_sequence)).toEqual([1, 2, 3, 4]);
    expect(new Set(first.map((event) => event.occurred_at)).size).toBe(1);
    expect(new Set(first.map((event) => event.session_id)).size).toBe(1);
    expect(first[1]).toMatchObject({ event_name: 'memos_note_create_click', page_id: 'memos' });
    expect(store.size).toBe(4);
    const restored = new ProductAnalyticsCollector(options);
    restored.setAccount('one');
    await restored.flush();
    expect(send.mock.calls[1]![1]).toEqual(first);
    collector.setAccount('two');
    collector.enterPage('days', '/days');
    await collector.flush();
    const next = send.mock.calls[2]![1][0]!;
    expect(next.event_sequence).toBe(5);
    expect(next.session_id).not.toBe(first[0]!.session_id);
  });
  it('离线恢复拒绝缺失会话和非法序号，不补造事件顺序', async () => {
    const { collector, options, store, send } = setup();
    const base = {
      event_id: '10000000-0000-4000-8000-999999999999',
      occurred_at: new Date(options.now()).toISOString(),
      kind: 'page_view',
      page_id: 'memos',
      event_name: 'memos_view',
      platform: 'web',
      session_id: '10000000-0000-4000-8000-999999999998',
      event_sequence: 1,
    };
    const invalid = [
      { ...base, session_id: undefined },
      { ...base, session_id: 'invalid' },
      { ...base, event_sequence: undefined },
      { ...base, event_sequence: 0 },
      { ...base, event_sequence: 1.5 },
      { ...base, event_sequence: 2_147_483_648 },
    ];
    for (const event of invalid) {
      store.set(`test:one:${event.event_id}`, JSON.stringify(event));
      collector.setAccount('one');
      await collector.flush();
      expect(send).not.toHaveBeenCalled();
      expect(store.size).toBe(0);
      collector.setAccount(null);
    }
  });
  it('离线恢复只保留与页面精确对应的访问标识，丢弃缺失、混用与不匹配标识的记录', async () => {
    const { collector, options, store, send } = setup();
    const base = {
      event_id: '10000000-0000-4000-8000-999999999999',
      occurred_at: new Date(options.now()).toISOString(),
      kind: 'page_view',
      page_id: 'accounting.transaction.editor',
      event_name: 'accounting_transaction_editor_view',
      platform: 'web',
      session_id: '10000000-0000-4000-8000-999999999998',
      event_sequence: 1,
    };
    const invalid = [
      { ...base, event_name: undefined },
      { ...base, event_name: 'accounting.transaction.editor' },
      { ...base, event_name: 'accounting.transaction.editor_view' },
      { ...base, event_name: 'accounting_view' },
      { ...base, event_name: 'accounting_transaction_create_click' },
      { ...base, page_id: undefined },
      { ...base, page_id: 'unknown', event_name: 'unknown_view' },
      { ...base, kind: 'active' },
      { ...base, kind: 'action' },
    ];
    for (const event of invalid) {
      store.set(`test:one:${event.event_id}`, JSON.stringify(event));
      collector.setAccount('one');
      await collector.flush();
      expect(send).not.toHaveBeenCalled();
      expect(store.size).toBe(0);
      collector.setAccount(null);
    }
    store.set(`test:one:${base.event_id}`, JSON.stringify(base));
    collector.setAccount('one');
    await collector.flush();
    expect(send.mock.calls[0]![1]).toEqual([base]);
    expect(store.size).toBe(0);
  });
  it('多个标签页分别写入不会覆盖，新开页面恢复各页离线记录', async () => {
    const { collector, options, send, online } = setup();
    online(false);
    collector.setAccount('one');
    const second = new ProductAnalyticsCollector(options);
    second.setAccount('one');
    collector.enterPage('fitness', '/fitness');
    second.enterPage('memos', '/memos');
    await settlePage();
    const reopened = new ProductAnalyticsCollector(options);
    reopened.setAccount('one');
    online(true);
    await reopened.flush();
    expect(send.mock.calls[0]![1].map((event) => event.page_id)).toEqual(['fitness', 'memos']);
  });
  it('重新渲染相同路由只记一次，返回已离开的页记新的访问', async () => {
    const { collector, send } = setup();
    collector.setAccount('one');
    for (let index = 0; index < 5; index++) collector.enterPage('fitness', '/fitness');
    await settlePage();
    collector.enterPage('memos', '/memos');
    await settlePage();
    collector.enterPage('fitness', '/fitness');
    await collector.flush();
    expect(send.mock.calls[0]![1].map((entry) => entry.page_id)).toEqual(['fitness', 'memos', 'fitness']);
  });
  it('匿名页面与后台页面刷新不计入，前台展示隐藏期间新进入的页面才记访问', async () => {
    const { collector, send, visibility } = setup();
    collector.enterPage('home', '/');
    collector.interact();
    collector.setAccount('one');
    visibility(false);
    collector.enterPage('fitness', '/fitness');
    collector.interact();
    await collector.flush();
    expect(send).not.toHaveBeenCalled();
    visibility(true);
    collector.interact();
    await collector.flush();
    expect(send.mock.calls[0]![1]).toHaveLength(1);
    expect(send.mock.calls[0]![1][0]).toMatchObject({ kind: 'page_view', page_id: 'fitness' });
  });
  it('跨上海午夜的真实交互新增活跃，重新回前台不重复增加浏览量', async () => {
    const { collector, send, time } = setup();
    time(Date.parse('2026-10-10T15:59:59Z'));
    collector.setAccount('one');
    collector.enterPage('home', '/');
    await settlePage();
    time(Date.parse('2026-10-10T16:00:01Z'));
    collector.interact();
    collector.interact();
    await collector.flush();
    expect(send.mock.calls[0]![1].map((event) => event.kind)).toEqual(['page_view', 'active']);
    expect(send.mock.calls[0]![1][0]!.event_name).toBe('home_view');
    expect(send.mock.calls[0]![1][1]).not.toHaveProperty('event_name');
  });
  it('离线队列在同一账号恢复后继续发送，重复发送沿用同一事件 UUID', async () => {
    const { collector, send, online, options } = setup();
    online(false);
    collector.setAccount('one');
    collector.enterPage('fitness', '/fitness');
    await collector.flush();
    expect(send).not.toHaveBeenCalled();
    const restored = new ProductAnalyticsCollector(options);
    restored.setAccount('one');
    online(true);
    send.mockRejectedValueOnce(new Error('offline'));
    await restored.flush();
    await restored.flush();
    expect(send.mock.calls[0]![1][0]!.event_id).toBe(send.mock.calls[1]![1][0]!.event_id);
  });
  it('切换账号撤销旧请求并清空旧持久队列，迟到成功不消费新队列', async () => {
    const { collector, send, store } = setup();
    let finish!: () => void;
    send.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    collector.setAccount('one');
    collector.enterPage('fitness', '/fitness');
    const old = collector.flush();
    collector.setAccount('two');
    collector.enterPage('days', '/days');
    expect(send.mock.calls[0]![2].aborted).toBe(true);
    expect([...store.keys()].some((key) => key.startsWith('test:one:'))).toBe(false);
    finish();
    await old;
    await collector.flush();
    expect(send.mock.calls[1]![0]).toBe('two');
    expect(send.mock.calls[1]![1].map((event) => event.page_id)).toEqual(['days']);
  });
  it('应用未提供可统计页面时不上传访问身份', async () => {
    const { collector, send } = setup();
    collector.setAccount('one');
    collector.enterPage(undefined, '/users/phone-or-uuid');
    collector.interact();
    await collector.flush();
    expect(send).not.toHaveBeenCalled();
  });
  it('格式损坏批次不堵塞后续事件，网络失败则保留', async () => {
    const { collector, send, store } = setup();
    collector.setAccount('one');
    collector.enterPage('home', '/');
    send.mockRejectedValueOnce({ status: 400 });
    await collector.flush();
    expect([...store.keys()].some((key) => key.startsWith('test:one:'))).toBe(false);
    collector.enterPage('fitness', '/fitness');
    await collector.flush();
    expect(send.mock.calls[1]![1]).toHaveLength(1);
  });
  it('业务动作保留固定事件名称离线重试，普通交互不生成点击且迟到成功不串账号', async () => {
    const { collector, options, send, online } = setup();
    online(false);
    collector.setAccount('one');
    collector.enterPage('memos', '/memos');
    collector.interact();
    collector.trackAction('memos_note_create_click', 'memos');
    collector.trackAction('memos_note_created', 'memos.editor', 'old-account');
    const restored = new ProductAnalyticsCollector(options);
    restored.setAccount('one');
    online(true);
    await restored.flush();
    expect(send.mock.calls[0]![1].filter((event) => event.kind === 'action')).toEqual([
      expect.objectContaining({ event_name: 'memos_note_create_click', page_id: 'memos', platform: 'web' }),
    ]);
    const action = send.mock.calls[0]![1].find((event) => event.kind === 'action')!;
    expect(Object.keys(action).sort()).toEqual([
      'event_id',
      'event_name',
      'event_sequence',
      'kind',
      'occurred_at',
      'page_id',
      'platform',
      'session_id',
    ]);
    collector.setAccount('two');
    collector.enterPage('memos', '/memos');
    collector.trackAction('memos_note_created', 'memos.editor', 'one');
    await collector.flush();
    expect(send.mock.calls[1]![1].filter((event) => event.kind === 'action')).toHaveLength(0);
  });
  it('未知动作与含业务内容的损坏离线事件不进入上报白名单', async () => {
    const { collector, options, store, send } = setup();
    collector.setAccount('one');
    collector.enterPage('memos', '/memos');
    collector.trackAction('用户私人标题' as never, 'memos');
    store.set(
      'test:one:10000000-0000-4000-8000-999999999999',
      JSON.stringify({
        event_id: '10000000-0000-4000-8000-999999999999',
        occurred_at: new Date(options.now()).toISOString(),
        kind: 'action',
        event_name: '用户私人标题',
        page_id: 'memos',
        platform: 'web',
      }),
    );
    const restored = new ProductAnalyticsCollector(options);
    restored.setAccount('one');
    await restored.flush();
    expect(send.mock.calls[0]![1]).toHaveLength(1);
    expect(send.mock.calls[0]![1][0]).toMatchObject({ kind: 'page_view', page_id: 'memos' });
  });
  it('前台发起的真实业务完成在后台仍可确认，后台点击不生成事件', async () => {
    const { collector, send, visibility } = setup();
    collector.setAccount('one');
    collector.enterPage('memos', '/memos');
    const context = collector.captureContext();
    visibility(false);
    collector.trackAction('memos_note_create_click', 'memos');
    collector.trackAction('memos_note_created', 'memos.editor', 'one', context);
    await collector.flush();
    expect(send.mock.calls[0]![1].filter((event) => event.kind === 'action')).toEqual([
      expect.objectContaining({ event_name: 'memos_note_created', page_id: 'memos.editor' }),
    ]);
  });
  it('真实交互延续三十分钟会话，补报不延长会话，异步成功沿用发起时上下文', async () => {
    const { collector, send, time, options } = setup();
    const started = options.now();
    collector.setAccount('one');
    collector.enterPage('memos', '/memos');
    const original = collector.beginFlow()!;
    collector.trackAction('memos_note_create_click', 'memos', 'one', original);
    time(started + 20 * 60_000);
    collector.interact();
    expect(collector.captureContext()?.sessionId).toBe(original.sessionId);
    time(started + 49 * 60_000);
    await collector.flush();
    time(started + 51 * 60_000);
    const later = collector.beginFlow()!;
    expect(later.sessionId).not.toBe(original.sessionId);
    collector.trackAction('memos_note_created', 'memos.editor', 'one', original);
    await collector.flush();
    expect(send.mock.calls[1]![1].find((event) => event.event_name === 'memos_note_created')).toMatchObject({
      session_id: original.sessionId,
      flow_id: original.flowId,
    });
  });

  it('独立新建和取消重开产生独立流程，旧保存不会借用新编辑器流程，源访问不补造关联', async () => {
    const { collector, send } = setup();
    collector.setAccount('one');
    collector.enterPage('accounting', '/accounting');
    const first = collector.beginFlow()!;
    collector.trackAction('accounting_transaction_create_click', 'accounting', 'one', first);
    const firstPage = Symbol('第一编辑器');
    collector.showSurface(firstPage, 'accounting.transaction.editor', 2, first);
    await collector.flush();
    const saving = collector.captureContext(first)!;
    collector.hideSurface(firstPage);
    const second = collector.beginFlow()!;
    collector.trackAction('accounting_transaction_create_click', 'accounting', 'one', second);
    collector.showSurface(Symbol('第二编辑器'), 'accounting.transaction.editor', 2, second);
    collector.trackAction('accounting_transaction_created', 'accounting.transaction.editor', 'one', saving);
    await collector.flush();
    expect(first.flowId).not.toBe(second.flowId);
    const events = send.mock.calls.flatMap((call) => call[1]);
    expect(
      events.find((event) => event.page_id === 'accounting' && event.kind === 'page_view')?.flow_id,
    ).toBeUndefined();
    expect(
      events
        .filter((event) => event.kind === 'page_view' && event.page_id === 'accounting.transaction.editor')
        .map((event) => event.flow_id),
    ).toEqual([first.flowId, second.flowId]);
    expect(events.find((event) => event.event_name === 'accounting_transaction_created')?.flow_id).toBe(first.flowId);
  });

  it('离线恢复原样保留会话和流程，账号来回切换后旧上下文仍失效', async () => {
    const { collector, options, send, online } = setup();
    online(false);
    collector.setAccount('one');
    collector.enterPage('credentials', '/credentials');
    const flow = collector.beginFlow()!;
    collector.trackAction('credentials_create_click', 'credentials', 'one', flow);
    const reopened = new ProductAnalyticsCollector(options);
    reopened.setAccount('one');
    online(true);
    await reopened.flush();
    expect(send.mock.calls[0]![1].find((event) => event.kind === 'action')).toMatchObject({
      session_id: flow.sessionId,
      flow_id: flow.flowId,
    });
    collector.setAccount('two');
    collector.setAccount('one');
    collector.enterPage('credentials', '/credentials');
    collector.trackAction('credentials_created', 'credentials.editor', 'one', flow);
    await collector.flush();
    expect(send.mock.calls[1]![1].filter((event) => event.kind === 'action')).toHaveLength(0);
  });
});
