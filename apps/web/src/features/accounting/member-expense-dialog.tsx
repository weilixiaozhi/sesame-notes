import type { components } from '@sesame-notes/api-client';
import { useSession } from '../../lib/session';
import { Dialog, EmptyState, ErrorState, LoadingState } from '../../components/ui';
import { amountPercent } from './accounting-analytics';
import { displayAmount, sumAmounts } from './money';
import { useMemberExpenseStats } from './member-expense-query';

/** 成员支出按付款人统计全部活记录；金额统一使用服务端返回的账本币种。 */
export function MemberExpenseDialog({
  ledger,
  onClose,
}: {
  ledger: components['schemas']['Ledger'];
  onClose: () => void;
}) {
  const { session } = useSession();
  const accountId = session!.user.user_id;
  const stats = useMemberExpenseStats(ledger, accountId);
  const items = stats.data?.items ?? [];
  const total = sumAmounts(items.map((member) => member.expense_total));
  const count = items.reduce((sum, member) => sum + member.tx_count, 0);
  return (
    <Dialog open title="成员支出" description={ledger.name} onClose={onClose}>
      {stats.isPending ? (
        <LoadingState label="正在读取成员支出…" />
      ) : stats.isError ? (
        <ErrorState error={stats.error} retry={() => void stats.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="还没有可归属成员的支出" />
      ) : (
        <div className="stack">
          <div>
            <span className="muted">全部时间 · 成员支出合计</span>
            <p className="stat-value">
              {displayAmount(total)} {stats.data.ledger_currency}
            </p>
            <p className="muted">
              {items.length} 位付款人 · {count} 笔支出
            </p>
          </div>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">付款人</th>
                  <th scope="col">支出</th>
                  <th scope="col">笔数</th>
                  <th scope="col">占比</th>
                </tr>
              </thead>
              <tbody>
                {items.map((member, index) => (
                  <tr key={member.member_id ?? member.user_id ?? `unknown-${index}`}>
                    <td>
                      {member.display_name?.trim() || '未知成员'}
                      {member.user_id === accountId ? '（我）' : ''}
                      {member.role === 'removed' && <span className="badge">已退出</span>}
                    </td>
                    <td>
                      {displayAmount(member.expense_total)} {stats.data.ledger_currency}
                    </td>
                    <td>{member.tx_count}</td>
                    <td>{amountPercent(member.expense_total, total).toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <section aria-label="统计口径">
            <h3>统计口径</h3>
            <p className="muted">按付款人统计，包含不参与 AA 的支出；无付款人的历史记录不计入。</p>
          </section>
        </div>
      )}
    </Dialog>
  );
}
