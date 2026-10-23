import { useEffect, useRef, useState } from 'react';
import {
  useQueryClient,
  type FetchNextPageOptions,
  type InfiniteData,
  type InfiniteQueryObserverResult,
} from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { Button } from '../../components/ui';

/** 后台刷新期间保留一次分页意图，等待新游标就绪；父级按查询键重新挂载以隔离筛选范围。 */
export function TransactionNextPage({
  queryHash,
  fetchNextPage,
  isFetchingNextPage,
}: {
  queryHash: string;
  fetchNextPage: (options?: FetchNextPageOptions) => Promise<InfiniteQueryObserverResult<InfiniteData<unknown>>>;
  isFetchingNextPage: boolean;
}) {
  const client = useQueryClient();
  const locked = useRef(false);
  const [pending, setPending] = useState(false);
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    if (!pending) return;
    let active = true;
    let inFlight = false;
    const cache = client.getQueryCache();
    const initialQuery = cache.get<InfiniteData<unknown>>(queryHash);
    const desiredPageCount = (initialQuery?.state.data?.pages.length ?? 0) + 1;

    /** 查询失败由列表错误区展示，取消自动翻页并恢复显式重试入口。 */
    const finish = () => {
      if (!active) return;
      locked.current = false;
      setPending(false);
      setWaiting(false);
    };

    /** 从缓存读取即时状态，避免 React 渲染通知滞后时取消刚开始的后台刷新。 */
    const drain = () => {
      if (!active || inFlight) return;
      const query = cache.get<InfiniteData<unknown>>(queryHash);
      if (!query) {
        finish();
        return;
      }
      if ((query.state.data?.pages.length ?? 0) >= desiredPageCount) {
        finish();
        return;
      }
      if (query.state.fetchStatus !== 'idle') {
        setWaiting(true);
        return;
      }
      if (query.state.status !== 'success') {
        finish();
        return;
      }
      inFlight = true;
      setWaiting(false);
      try {
        // 此刻没有其他读取；false 同时防止重复触发取消已在进行的请求。
        void fetchNextPage({ cancelRefetch: false }).then((result) => {
          inFlight = false;
          if (!active) return;
          // 后台失效会取消已发出的分页，但 observer 的 Promise 仍可能正常结束。
          // 只有真实追加一页或已到末页才消费意图；刷新失败交给显式重试。
          if (result.isError || !result.hasNextPage) {
            finish();
            return;
          }
          queueMicrotask(drain);
        }, finish);
      } catch {
        finish();
      }
    };
    const unsubscribe = cache.subscribe((event) => {
      if (event.query.queryHash === queryHash) {
        // 在当前缓存通知结束后读取最终状态，连续失效只会保留一个分页意图。
        queueMicrotask(drain);
      }
    });
    drain();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [client, fetchNextPage, pending, queryHash]);

  return (
    <Button
      variant="secondary"
      disabled={pending || isFetchingNextPage}
      aria-busy={pending || isFetchingNextPage}
      onClick={() => {
        if (locked.current || isFetchingNextPage) return;
        locked.current = true;
        setPending(true);
      }}
    >
      <ChevronDown size={17} />
      {waiting ? '刷新后继续加载…' : pending || isFetchingNextPage ? '正在加载…' : '加载更多记录'}
    </Button>
  );
}
