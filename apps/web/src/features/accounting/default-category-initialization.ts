import { useCallback, useEffect, useRef, useState } from 'react';
import { unwrap, type components } from '@sesame-notes/api-client';
import { captureSessionOperation, queryClient } from '../../lib/session';

type Ledger = components['schemas']['Ledger'];

/** 进入本人空目录时显式初始化一次；服务端以包含墓碑的账号目录判定是否需要创建。 */
export function useDefaultCategoryInitialization(ledger: Ledger, accountId: string, emptyLoaded: boolean) {
  const scope = `${accountId}:${ledger.id}`;
  const [state, setState] = useState<{ scope: string; isPending: boolean; error: unknown }>({
    scope,
    isPending: false,
    error: null,
  });
  const lifecycle = useRef<AbortController | null>(null);
  const attempt = useRef<{ key: string; started: boolean; running: boolean } | null>(null);
  const ledgerId = ledger.id;
  const role = ledger.role;
  const run = useCallback(async () => {
    const active = lifecycle.current;
    const current = attempt.current;
    if (!active || active.signal.aborted || !current || current.running || role !== 'owner') return;
    const completedKey = ['account', accountId, 'accounting', 'default-categories-initialized'];
    if (queryClient.getQueryData<boolean>(completedKey)) return;
    current.running = true;
    current.started = true;
    setState({ scope, isPending: true, error: null });
    let signal = active.signal;
    try {
      const operation = captureSessionOperation();
      signal = AbortSignal.any([active.signal, operation.signal]);
      signal.throwIfAborted();
      unwrap(
        await operation.client.POST('/api/v1/ledgers/{ledger_id}/categories/add-batch', {
          signal,
          params: { path: { ledger_id: ledgerId }, header: { 'idempotency-key': current.key } },
          body: { items: [], initialize_defaults: true },
        }),
      );
      operation.assertCurrent();
      signal.throwIfAborted();
      // 空结果也代表服务端已检查墓碑。成功标记只存账号查询缓存，退出时统一清除。
      queryClient.setQueryDefaults(completedKey, { gcTime: Infinity });
      queryClient.setQueryData(completedKey, true);
      // 幂等响应可能早于别端编辑，始终重新读取分类，不能把首次响应覆写到当前缓存。
      await queryClient.invalidateQueries({
        queryKey: ['account', accountId, 'accounting'],
        predicate: ({ queryKey }) => queryKey[4] === 'categories',
      });
      operation.assertCurrent();
      signal.throwIfAborted();
    } catch (error) {
      if (!active.signal.aborted && lifecycle.current === active) {
        setState({ scope, isPending: false, error: signal.aborted ? null : error });
      }
      return;
    } finally {
      current.running = false;
    }
    if (!active.signal.aborted && lifecycle.current === active) setState({ scope, isPending: false, error: null });
  }, [accountId, ledgerId, role, scope]);

  useEffect(() => {
    const active = new AbortController();
    lifecycle.current = active;
    attempt.current = { key: crypto.randomUUID(), started: false, running: false };
    return () => {
      active.abort();
    };
  }, [accountId, ledgerId]);

  useEffect(() => {
    const active = lifecycle.current;
    queueMicrotask(() => {
      if (
        active &&
        lifecycle.current === active &&
        !active.signal.aborted &&
        emptyLoaded &&
        !attempt.current?.started
      ) {
        void run();
      }
    });
  }, [emptyLoaded, run]);

  return {
    isPending: state.scope === scope && state.isPending,
    error: state.scope === scope ? state.error : null,
    retry: () => {
      void run();
    },
  };
}
