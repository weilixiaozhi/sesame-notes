import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { unwrap, type components, type paths } from '@sesame-notes/api-client';
import { api, useSession } from '../../lib/session';
import { Button, Dialog, EmptyState, ErrorState, LoadingState } from '../../components/ui';
import { displayAmount } from './money';
import { useMemberExpenseStats } from './member-expense-query';
import { transactionShares } from './aa-transaction-shares';
type AaStats = paths['/api/v1/ledgers/{ledger_id}/aa-stats']['get']['responses'][200]['content']['application/json'];

/** AA 汇总覆盖整个账本，展示服务端精确分摊与结算建议，不把建议当作已发生的付款。 */
export function AaStatisticsDialog({
  ledger,
  onClose,
}: {
  ledger: components['schemas']['Ledger'];
  onClose: () => void;
}) {
  const { session } = useSession();
  const accountId = session!.user.user_id;
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);
  const [excluded, setExcluded] = useState(false);
  const memberExpenses = useMemberExpenseStats(ledger, accountId);
  const totalPaid = new Map(memberExpenses.data?.items.map((member) => [member.member_id, member.expense_total]) ?? []);
  const stats = useQuery({
    queryKey: ['account', accountId, 'accounting', ledger.id, 'aa-stats', ledger.currency],
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/ledgers/{ledger_id}/aa-stats', {
          signal,
          params: { path: { ledger_id: ledger.id } },
        }),
      ),
  });
  return (
    <>
      <Dialog
        open
        title="AA 分摊与结算"
        description={`${ledger.name} · 全部时间 · ${ledger.currency}`}
        onClose={onClose}
      >
        {stats.isPending ? (
          <LoadingState label="正在计算完整账本的 AA 分摊…" />
        ) : stats.isError ? (
          <ErrorState error={stats.error} retry={() => void stats.refetch()} />
        ) : (
          <div className="stack">
            {memberExpenses.isError && (
              <ErrorState error={memberExpenses.error} retry={() => void memberExpenses.refetch()} />
            )}
            <p className="muted">选择“不参与 AA”的记录单独展示，不进入结算建议。</p>
            {stats.data.skipped_count > 0 && (
              <p className="notice">
                有 {stats.data.skipped_count} 笔记录因付款人或分摊信息不完整而未参与计算，请核对后再结算。
              </p>
            )}
            {stats.data.participants.length === 0 ? (
              <EmptyState title="还没有可分摊的记录" description="在记账时选择付款人和 AA 方式，即可查看分摊。" />
            ) : (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>成员</th>
                      <th>总付</th>
                      <th>分摊实付</th>
                      <th>应摊</th>
                      <th>净额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.data.participants.map((member) => (
                      <tr key={member.member_id}>
                        <td>
                          <Button
                            variant="ghost"
                            onClick={() => setSelected({ id: member.member_id, name: member.display_name })}
                          >
                            {member.display_name}
                            {member.is_self ? '（我）' : ''}
                          </Button>
                        </td>
                        <td>
                          {memberExpenses.isSuccess &&
                          memberExpenses.data.ledger_currency === stats.data.ledger_currency
                            ? displayAmount(totalPaid.get(member.member_id) ?? '0')
                            : '—'}
                        </td>
                        <td>{displayAmount(member.total_paid)}</td>
                        <td>{displayAmount(member.total_should_pay)}</td>
                        <td>
                          {member.net.startsWith('-')
                            ? `应付 ${displayAmount(member.net.slice(1))}`
                            : member.net === '0'
                              ? '已平衡'
                              : `应收 ${displayAmount(member.net)}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <h3>结算建议</h3>
            <p className="muted">
              这是按现有账单计算的建议，不会创建交易或标记为已转账。分摊汇总保留原始精度，建议付款金额按两位小数显示。
            </p>
            {stats.data.transfers.length === 0 ? (
              <p>目前没有需要结算的差额。</p>
            ) : (
              <ul className="category-list">
                {stats.data.transfers.map((transfer, index) => {
                  const from =
                    stats.data.participants.find((item) => item.member_id === transfer.from_member_id)?.display_name ??
                    '未知成员';
                  const to =
                    stats.data.participants.find((item) => item.member_id === transfer.to_member_id)?.display_name ??
                    '未知成员';
                  return (
                    <li className="stack" key={`${transfer.from_member_id}:${transfer.to_member_id}:${index}`}>
                      <span>
                        {from} → {to}{' '}
                        <strong>
                          {displayAmount(transfer.amount)} {stats.data.ledger_currency}
                        </strong>
                      </span>
                      {transfer.amount !== transfer.exact_amount && (
                        <span className="muted">
                          未舍入差额：{displayAmount(transfer.exact_amount)} {stats.data.ledger_currency}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <Button variant="secondary" onClick={() => setExcluded(true)}>
              查看不参与 AA 的 {stats.data.excluded_count} 笔记录
            </Button>
          </div>
        )}
      </Dialog>
      {selected && stats.data && (
        <AaTransactions
          ledger={ledger}
          accountId={accountId}
          participants={stats.data.participants}
          member={selected}
          onClose={() => setSelected(null)}
        />
      )}
      {excluded && stats.data && (
        <AaTransactions
          ledger={ledger}
          accountId={accountId}
          participants={stats.data.participants}
          onClose={() => setExcluded(false)}
        />
      )}
    </>
  );
}

/** 成员详单按付款成员分页查询，保留不分摊支出，避免将记录人误作付款人。 */
function AaTransactions({
  ledger,
  accountId,
  member,
  participants,
  onClose,
}: {
  ledger: components['schemas']['Ledger'];
  accountId: string;
  member?: { id: string; name: string };
  participants: AaStats['participants'];
  onClose: () => void;
}) {
  const memberPool = useQuery({
    queryKey: ['account', accountId, 'accounting', ledger.id, 'participants'],
    enabled: Boolean(member),
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/ledgers/{ledger_id}/participants', {
          signal,
          params: { path: { ledger_id: ledger.id } },
        }),
      ),
  });
  const records = useInfiniteQuery({
    queryKey: [
      'account',
      accountId,
      'accounting',
      ledger.id,
      'aa-transactions',
      ledger.currency,
      member?.id ?? 'excluded',
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      unwrap(
        await api.GET('/api/v1/ledgers/{ledger_id}/transactions', {
          signal,
          params: {
            path: { ledger_id: ledger.id },
            query: {
              limit: 40,
              ...(pageParam ? { cursor: pageParam } : {}),
              ...(member ? { payer_member_id: member.id } : { aa_mode: 1 }),
            },
          },
        }),
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const items = records.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Dialog
      open
      title={member ? `${member.name}的付款明细` : '不参与 AA 的支出'}
      description={`全部时间 · ${ledger.currency}${member ? ' · 包含不参与 AA 的记录' : ''}`}
      onClose={onClose}
    >
      {records.isPending ? (
        <LoadingState />
      ) : records.isError && items.length === 0 ? (
        <ErrorState error={records.error} retry={() => void records.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="没有符合条件的支出" />
      ) : (
        <div className="stack">
          {memberPool.isError && <ErrorState error={memberPool.error} retry={() => void memberPool.refetch()} />}
          <ul className="category-list">
            {items.map((item) => {
              const shares = transactionShares(item, memberPool.data?.map((participant) => participant.id) ?? []);
              return (
                <li key={item.id} className="stack">
                  <div className="toolbar">
                    <strong>
                      {item.category_name ?? '未分类'} · {displayAmount(item.native_amount)} {ledger.currency}
                    </strong>
                    <span className="badge">
                      {item.aa_mode === '1' ? '不分摊' : item.aa_mode === '2' ? '自定义分摊' : '人均分摊'}
                    </span>
                  </div>
                  <span className="muted">
                    {new Date(item.happened_at).toLocaleString('zh-CN')}
                    {item.note ? ` · ${item.note}` : ''}
                  </span>
                  {item.currency_code !== ledger.currency && (
                    <span className="muted">
                      原币 {displayAmount(item.amount)} {item.currency_code}
                    </span>
                  )}
                  {shares && (
                    <details>
                      <summary>查看每人应摊</summary>
                      <ul className="category-list">
                        {[...shares.entries()].map(([id, amount]) => (
                          <li className="toolbar" key={id}>
                            <span>
                              {participants.find((participant) => participant.member_id === id)?.display_name ??
                                '未知成员'}
                            </span>
                            <strong>
                              {displayAmount(amount)} {ledger.currency}
                            </strong>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {!shares && item.aa_mode !== '1' && !memberPool.isPending && !memberPool.isError && (
                    <p className="muted">付款人或分摊信息不完整，暂不能计算每人应摊。</p>
                  )}
                </li>
              );
            })}
          </ul>
          {records.isError && (
            <ErrorState
              error={records.error}
              retry={() => void (records.isFetchNextPageError ? records.fetchNextPage() : records.refetch())}
            />
          )}
          {records.hasNextPage && (
            <Button variant="secondary" disabled={records.isFetching} onClick={() => void records.fetchNextPage()}>
              {records.isFetchingNextPage ? '加载中…' : '加载更多明细'}
            </Button>
          )}
        </div>
      )}
    </Dialog>
  );
}
