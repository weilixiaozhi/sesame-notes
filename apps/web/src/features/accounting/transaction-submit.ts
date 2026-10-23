import { ApiError, unwrap, type components, type paths } from '@sesame-notes/api-client';
import { captureSessionOperation } from '../../lib/session';
import { createTransactionUpdater, readTransactionRecoverySnapshot } from './transaction-update';

type Transaction = components['schemas']['Transaction'];
type TransactionInput =
  paths['/api/v1/ledgers/{ledger_id}/transactions']['post']['requestBody']['content']['application/json'];
type Attempt = { body: TransactionInput; fingerprint: string; key: string; definitelyRejected: boolean };

/** 同一编辑过程固定记录 ID；网络结果未知时先用原请求恢复确认，再把后续修改写回同一条记录。 */
export function createTransactionSubmitter(
  ledger: Pick<components['schemas']['Ledger'], 'id' | 'sync_id'>,
  accountId: string,
) {
  const operation = captureSessionOperation();
  const api = operation.client;
  const id = crypto.randomUUID();
  let attempt: Attempt | null = null;
  let confirmed: Transaction | null = null;
  let confirmedFingerprint = '';
  let updater: ReturnType<typeof createTransactionUpdater> | null = null;

  /** 仅明确的客户端拒绝允许直接替换请求；网络错误和服务端错误保留原请求做幂等重放。 */
  async function submit(values: TransactionInput): Promise<Transaction> {
    try {
      operation.assertCurrent();
      const body = { ...values, id };
      const fingerprint = JSON.stringify(body);
      if (!confirmed) {
        // 未知结果的重放仍使用原键和原载荷；先验证代次，避免把旧账本请求重放到清空后的账本。
        if (attempt && !attempt.definitelyRejected) await readTransactionRecoverySnapshot(ledger, operation);
        if (!attempt || (attempt.definitelyRejected && attempt.fingerprint !== fingerprint)) {
          attempt = { body: structuredClone(body), fingerprint, key: crypto.randomUUID(), definitelyRejected: false };
        }
        try {
          confirmed = unwrap(
            await api.POST('/api/v1/ledgers/{ledger_id}/transactions', {
              params: { path: { ledger_id: ledger.id }, header: { 'idempotency-key': attempt.key } },
              body: attempt.body,
            }),
          );
          operation.assertCurrent();
          confirmedFingerprint = attempt.fingerprint;
          attempt = null;
        } catch (error) {
          if (attempt)
            attempt.definitelyRejected =
              error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408;
          throw error;
        }
      }
      // 已开始修改这条记录后，任何草稿都先交给同一保存器恢复待确认 PATCH，不能跳过未知结果。
      if (!updater && confirmedFingerprint === fingerprint) return confirmed;
      updater ??= createTransactionUpdater(ledger, confirmed, accountId);
      const { id: _id, ...patch } = body;
      return await updater.submit(patch);
    } catch (error) {
      console.error('新增支出保存未完成', {
        ledgerId: ledger.id,
        transactionId: id,
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : '未知错误',
      });
      throw error;
    }
  }

  /** 新增结果已确认后的编辑冲突，与已有支出使用相同的显式版本核对入口。 */
  function acceptReviewed(current: Transaction): void {
    operation.assertCurrent();
    if (!updater) throw new Error('尚未取得可核对的支出版本，请先保存以确认结果。');
    updater.acceptReviewed(current);
  }

  return { submit, acceptReviewed };
}
