import { hashKey, useQueryClient, type QueryKey } from '@tanstack/react-query';

/** 人工查询始终读取目标条件的最新数据，缓存身份只由业务条件与分页决定。 */
export function useListQuerySubmit(queryKey: QueryKey, enabled = true) {
  const client = useQueryClient();
  const currentKey = hashKey(queryKey);

  /** 先使目标缓存失效；相同条件主动重取，变更条件由页面的新查询发出一次请求。 */
  function submit(nextKey: QueryKey, apply: () => void): void {
    if (!enabled || client.getQueryState(queryKey)?.fetchStatus === 'fetching') return;
    // none 分支同步标记缓存失效，随后直接提交条件，不制造延迟应用旧条件的异步窗口。
    void client.invalidateQueries({ queryKey: nextKey, exact: true, refetchType: 'none' });
    apply();
    if (currentKey === hashKey(nextKey)) {
      // 查询层负责读取错误状态与取消；请求边界记录日志，当前层不重复吞掉异常。
      void client.refetchQueries({ queryKey: nextKey, exact: true, type: 'active' }, { cancelRefetch: false });
    }
  }

  return submit;
}
