import { useQuery } from '@tanstack/react-query';
import { Pencil, Trash2 } from 'lucide-react';
import { unwrap, type components } from '@sesame-notes/api-client';
import { Button, Dialog, ErrorState, LoadingState } from '../../components/ui';
import { api, useSession } from '../../lib/session';
import { useProductAnalyticsPage } from '../../lib/use-product-analytics';
import type { ProductAnalyticsContext } from '../../lib/product-analytics-runtime';
import { CategoryIcon } from './category-icons';
import { displayAmount } from './money';
import './transaction-detail.css';

type Transaction = components['schemas']['Transaction'];
type Category = components['schemas']['Category'];
type Ledger = components['schemas']['Ledger'];
type Member = components['schemas']['Member'];

/** 从交易分类恢复完整父子路径，分类缺失时保留记录返回的可读名称。 */
function categoryPath(transaction: Transaction, categories: Category[]): string {
  const category = categories.find((entry) => entry.id === transaction.category_id);
  if (!category) return transaction.category_name || '未分类';
  const parent = category.parent_id ? categories.find((entry) => entry.id === category.parent_id) : undefined;
  return parent && parent.id !== category.id ? `${parent.name} / ${category.name}` : category.name;
}

/** 完整展示本地发生时间；历史异常日期不影响查看金额、备注及后续编辑。 */
function happenedAtLabel(transaction: Transaction): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(transaction.happened_at));
  } catch (error) {
    console.error('支出详情发生时间格式化失败', { transactionId: transaction.id, error });
    return '时间待确认，可在编辑时重新设置';
  }
}

/** 依据账本成员目录展示支出人与分摊人，历史成员保留退出状态。 */
function memberLabel(memberId: string | null, members: Member[]): string {
  if (!memberId) return '未设置';
  const member = members.find((entry) => entry.id === memberId);
  if (!member) return '成员资料暂不可用';
  return `${member.display_name}${member.status !== 'ACTIVE' ? '（已退出）' : ''}`;
}

/** 支出先查看再编辑，主要操作常驻底部，归档记录仅展示只读内容。 */
export function TransactionDetail({
  transaction,
  ledger,
  categories,
  analyticsContext,
  onClose,
  onEdit,
  onDelete,
}: {
  transaction: Transaction;
  ledger: Ledger;
  categories: Category[];
  analyticsContext?: ProductAnalyticsContext | null;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { session } = useSession();
  useProductAnalyticsPage('accounting.transaction', true, 2, analyticsContext);
  const category = categories.find((entry) => entry.id === transaction.category_id);
  // 关闭 AA 的账本仍可回顾历史自定义分摊，普通记录默认的模式值不作为参与均摊的依据。
  const showAa =
    ledger.aa_enabled || transaction.aa_mode === '1' || transaction.aa_mode === '2' || transaction.splits.length > 0;
  const showMembers = showAa || Boolean(transaction.payer_member_id);
  const members = useQuery({
    queryKey: ['account', session?.user.user_id, 'accounting', ledger.id, 'participants'],
    enabled: showMembers,
    queryFn: async ({ signal }) => {
      try {
        return unwrap(
          await api.GET('/api/v1/ledgers/{ledger_id}/participants', {
            signal,
            params: { path: { ledger_id: ledger.id } },
          }),
        );
      } catch (error) {
        if (!signal.aborted)
          console.error('支出详情成员目录读取失败', { ledgerId: ledger.id, transactionId: transaction.id, error });
        throw error;
      }
    },
  });
  const foreign = transaction.currency_code !== ledger.currency;
  const archived = Boolean(ledger.archived_at);
  const aaMode = transaction.aa_mode === '2' ? '指定分摊' : transaction.aa_mode === '1' ? '不分摊' : '人均分摊';
  const title = categoryPath(transaction, categories);

  return (
    <Dialog
      open
      mobileFullscreen
      autoFocus={false}
      className="transaction-detail-dialog"
      title={title}
      heading={
        <div className="transaction-detail-heading">
          <span className="transaction-detail-category-icon" aria-hidden="true">
            <CategoryIcon name={category?.icon ?? null} size={20} />
          </span>
          <div className="transaction-detail-heading-copy">
            <h3>{title}</h3>
            {transaction.note && <p className="transaction-detail-note">{transaction.note}</p>}
          </div>
          {!archived && (
            <button
              type="button"
              className="icon-button transaction-detail-delete"
              aria-label="删除"
              onClick={onDelete}
            >
              <Trash2 size={20} />
            </button>
          )}
        </div>
      }
      onClose={onClose}
      footer={
        !archived && (
          <div className="transaction-detail-actions">
            <Button onClick={onEdit}>
              <Pencil size={18} />
              编辑记账
            </Button>
          </div>
        )
      }
    >
      <div className="transaction-detail">
        <dl className="transaction-detail-information">
          <div>
            <dt>记账日期</dt>
            <dd>{happenedAtLabel(transaction)}</dd>
          </div>
          <div>
            <dt>记账金额</dt>
            <dd
              className="transaction-detail-amount"
              aria-label={`记账金额 ${transaction.currency_code} ${transaction.amount}`}
            >
              {transaction.currency_code} {displayAmount(transaction.amount)}
            </dd>
          </div>
          <div>
            <dt>货币</dt>
            <dd>{transaction.currency_code}</dd>
          </div>
          {foreign && (
            <div>
              <dt>折合主货币</dt>
              <dd>
                ≈ {ledger.currency} {displayAmount(transaction.native_amount)}
              </dd>
            </div>
          )}
        </dl>
        {showMembers && (
          <section className="transaction-detail-aa" aria-label={showAa ? '分摊方式' : '支出人'}>
            {showAa && <h3>分摊方式</h3>}
            {members.isPending ? (
              <LoadingState label="正在读取账本成员…" />
            ) : (
              <>
                {members.isError && <ErrorState error={members.error} retry={() => void members.refetch()} />}
                <dl className="transaction-detail-information">
                  {showAa && (
                    <div>
                      <dt>分摊方式</dt>
                      <dd>{aaMode}</dd>
                    </div>
                  )}
                  <div>
                    <dt>支出人</dt>
                    <dd>{memberLabel(transaction.payer_member_id, members.data ?? [])}</dd>
                  </div>
                  {showAa && transaction.aa_mode !== '1' && transaction.aa_mode !== '2' && (
                    <div>
                      <dt>参与人</dt>
                      <dd>全部成员</dd>
                    </div>
                  )}
                </dl>
                {transaction.aa_mode === '2' && (
                  <div className="transaction-detail-splits">
                    <p>分摊明细 · {ledger.currency}</p>
                    {transaction.splits.length > 0 ? (
                      <ul>
                        {transaction.splits.map((split) => (
                          <li key={split.member_id}>
                            <span>{memberLabel(split.member_id, members.data ?? [])}</span>
                            <strong>{displayAmount(split.amount)}</strong>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">这笔记录的分摊明细待确认。</p>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        )}
        {archived && <p className="notice">这个账本已归档。取消归档后可以编辑或删除支出。</p>}
      </div>
    </Dialog>
  );
}
