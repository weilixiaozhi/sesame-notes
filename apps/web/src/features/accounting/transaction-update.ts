import { ApiError, unwrap, type components, type paths } from '@sesame-notes/api-client';
import { captureSessionOperation } from '../../lib/session';
import { canonicalAmount } from './money';

type Transaction = components['schemas']['Transaction'];
type Ledger = components['schemas']['Ledger'];
type Patch = Omit<
  paths['/api/v1/ledgers/{ledger_id}/transactions/{transaction_id}']['patch']['requestBody']['content']['application/json'],
  'base_revision'
>;
type Attempt = { base: Transaction; body: Patch };

/** 恢复写入结果时固定账号与账本代次，返回当前完整快照供保存器核对。 */
export async function readTransactionRecoverySnapshot(
  ledger: Pick<Ledger, 'id' | 'sync_id'>,
  operation: ReturnType<typeof captureSessionOperation>,
) {
  operation.assertCurrent();
  const snapshot = unwrap(
    await operation.client.GET('/api/v1/sync/full', {
      params: { query: { ledger_id: ledger.id, sync_id: ledger.sync_id } },
    }),
  );
  operation.assertCurrent();
  if (snapshot.ledger.id !== ledger.id || snapshot.ledger.sync_id !== ledger.sync_id)
    throw new ApiError(412, 'LEDGER_CHANGED', '账本已发生变化，草稿仍保留，请重新打开账本后核对。');
  return snapshot;
}

/** 日志保留错误类型、调用栈与接口错误码，不序列化冲突错误携带的交易内容。 */
function errorDetails(error: unknown) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : '未知错误',
    stack: error instanceof Error ? error.stack : undefined,
    status: error instanceof ApiError ? error.status : undefined,
    code: error instanceof ApiError ? error.code : undefined,
  };
}

/** 冲突携带已读取的云端记录，界面保留草稿并等待用户核对。 */
export class TransactionEditConflict extends Error {
  /** 保存用于核对的权威版本，不在错误信息中记录交易内容。 */
  constructor(
    readonly current: Transaction,
    readonly memberNames: Record<string, string> = {},
  ) {
    super('云端支出与本次草稿不同，请核对下方云端内容后继续编辑。');
    this.name = 'TransactionEditConflict';
  }
}

/** 只比较可写内容和原记录来源；金额不经过浮点数，分摊顺序不影响结果。 */
function transactionState(transaction: Transaction): string {
  return JSON.stringify({
    ledger: transaction.ledger_id,
    id: transaction.id,
    type: transaction.tx_type,
    amount: canonicalAmount(transaction.amount),
    nativeAmount: canonicalAmount(transaction.native_amount),
    currency: transaction.currency_code,
    happenedAt: new Date(transaction.happened_at).toISOString(),
    category: transaction.category_id,
    note: transaction.note,
    payer: transaction.payer_member_id,
    aaMode: transaction.aa_mode ?? '0',
    splits: transaction.splits
      .map((split) => [split.member_id, canonicalAmount(split.amount)])
      .sort(([left], [right]) => (left ?? '').localeCompare(right ?? '')),
    recurring: transaction.recurring_id,
    occurrenceDate: transaction.occurrence_date,
  });
}

/** 固定会话、账本代次和编辑基线；未知结果先核对，真实冲突只能经用户确认后更新基线。 */
export function createTransactionUpdater(
  ledger: Pick<Ledger, 'id' | 'sync_id'>,
  existing: Transaction,
  accountId: string,
) {
  const operation = captureSessionOperation();
  const api = operation.client;
  let base = existing;
  let attempt: Attempt | null = null;
  let conflict: TransactionEditConflict | null = null;
  let memberNames: Record<string, string> = {};
  let confirmedBody: string | null = null;

  /** 读取完整权威快照，避免列表筛选、分页或缓存把目标记录误判为不存在。 */
  async function readCurrent(): Promise<Transaction> {
    const snapshot = await readTransactionRecoverySnapshot(ledger, operation);
    memberNames = Object.fromEntries(snapshot.members.map((member) => [member.id, member.display_name]));
    const current = snapshot.transactions.find((transaction) => transaction.id === existing.id);
    if (!current) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', '这笔支出已被删除，草稿仍保留，请核对后再处理。');
    return current;
  }

  /** 服务端把显式空付款人解析为当前账号，核对时通过成员接口取得同一权威身份。 */
  async function expectedState(pending: Attempt): Promise<string> {
    let payer = pending.body.payer_member_id;
    if (payer === null) {
      const members = unwrap(
        await api.GET('/api/v1/ledgers/{ledger_id}/members', { params: { path: { ledger_id: ledger.id } } }),
      );
      operation.assertCurrent();
      const own = members.find((member) => member.user_id === accountId);
      if (!own) throw new Error('无法确认本次保存的付款人，草稿仍保留，请稍后重试。');
      payer = own.member_id;
    }
    // 缺省字段沿用原记录，显式 null 保留清空语义；原记录的来源字段必须一并保持一致。
    const patch = Object.fromEntries(Object.entries(pending.body).filter(([, value]) => value !== undefined));
    return transactionState({
      ...pending.base,
      ...patch,
      splits: pending.body.splits === undefined ? pending.base.splits : (pending.body.splits ?? []),
      payer_member_id: payer === undefined ? pending.base.payer_member_id : payer,
    });
  }

  /** 仅在权威完整内容匹配且版本推进时确认成功；相同基线允许原请求安全重试。 */
  async function inspect(pending: Attempt): Promise<Transaction | null> {
    const current = await readCurrent();
    if (current.revision > pending.base.revision && transactionState(current) === (await expectedState(pending))) {
      base = current;
      attempt = null;
      conflict = null;
      confirmedBody = JSON.stringify(pending.body);
      return current;
    }
    if (current.revision === pending.base.revision && transactionState(current) === transactionState(pending.base))
      return null;
    conflict = new TransactionEditConflict(current, memberNames);
    throw conflict;
  }

  /** 发送冻结请求；响应丢失和乐观锁冲突都经过权威状态确认，禁止盲目提升版本。 */
  async function write(pending: Attempt): Promise<Transaction> {
    try {
      operation.assertCurrent();
      const updated = unwrap(
        await api.PATCH('/api/v1/ledgers/{ledger_id}/transactions/{transaction_id}', {
          params: { path: { ledger_id: ledger.id, transaction_id: existing.id } },
          body: { ...pending.body, base_revision: pending.base.revision },
        }),
      );
      operation.assertCurrent();
      base = updated;
      attempt = null;
      conflict = null;
      confirmedBody = JSON.stringify(pending.body);
      return updated;
    } catch (error) {
      console.error('支出更新请求失败', {
        ledgerId: ledger.id,
        transactionId: existing.id,
        baseRevision: pending.base.revision,
        error: errorDetails(error),
      });
      // 明确拒绝的业务错误没有提交；会话和权限错误也不能触发后续读取或写入。
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        !(error.status === 409 && error.code === 'SYNC_CONFLICT')
      ) {
        attempt = null;
        throw error;
      }
      try {
        const confirmed = await inspect(pending);
        if (confirmed) return confirmed;
      } catch (recoveryError) {
        if (recoveryError instanceof TransactionEditConflict || recoveryError instanceof ApiError) throw recoveryError;
        console.error('支出保存结果核对失败', {
          ledgerId: ledger.id,
          transactionId: existing.id,
          error: errorDetails(recoveryError),
        });
        throw new Error('暂时无法确认保存结果，草稿仍保留；请恢复网络后再次保存以核对结果。', { cause: recoveryError });
      }
      throw error;
    }
  }

  /** 先恢复冻结请求，再提交之后修改的草稿；已确认的同一内容不会再次增加版本。 */
  async function submit(body: Patch): Promise<Transaction> {
    try {
      operation.assertCurrent();
      if (conflict) throw conflict;
      if (attempt) {
        const pending = attempt;
        const recovered = (await inspect(pending)) ?? (await write(pending));
        if (JSON.stringify(pending.body) === JSON.stringify(body)) return recovered;
      }
      if (confirmedBody === JSON.stringify(body)) return base;
      const pending = { base, body: structuredClone(body) };
      attempt = pending;
      return await write(pending);
    } catch (error) {
      console.error('支出编辑未完成', { ledgerId: ledger.id, transactionId: existing.id, error: errorDetails(error) });
      throw error;
    }
  }

  /** 只接受界面已展示并由用户明确核对的冲突版本，保留表单内容等待下一次保存。 */
  function acceptReviewed(current: Transaction): void {
    operation.assertCurrent();
    if (conflict?.current !== current) throw new Error('云端版本已变化，请重新核对。');
    base = current;
    attempt = null;
    conflict = null;
    confirmedBody = null;
  }

  return { submit, acceptReviewed };
}
