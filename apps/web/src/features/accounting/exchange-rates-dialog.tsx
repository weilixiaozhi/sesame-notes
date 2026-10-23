import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { unwrap, type components } from '@sesame-notes/api-client';
import { api, pushChange, useSession } from '../../lib/session';
import { useDraftClose } from '../../components/use-draft-close';
import { useProductAnalyticsPage } from '../../lib/use-product-analytics';
import { Button, Dialog, EmptyState, ErrorState, Field, LoadingState } from '../../components/ui';
import { canonicalRate } from './currency-math';
import { exchangeRateOverrideId } from './exchange-rate-id';
import { PendingOperationGuard } from './pending-operation-guard';
type Override = components['schemas']['ExchangeRateOverride'];

/** 账号级手动汇率优先于自动汇率，不追溯修改已记录交易的折算金额。 */
export function ExchangeRatesDialog({ initialBase, onClose }: { initialBase: string; onClose: () => void }) {
  useProductAnalyticsPage('accounting.exchange_rate', true, 3);
  const { session } = useSession();
  const accountId = session!.user.user_id;
  const [base, setBase] = useState(initialBase);
  const [editing, setEditing] = useState<Override | 'new' | null>(null);
  const [removing, setRemoving] = useState<Override | null>(null);
  const attempt = useRef({ id: '', mutationId: crypto.randomUUID(), at: new Date().toISOString() });
  const records = useQuery({
    queryKey: ['account', accountId, 'accounting', 'exchange-rate-overrides', base],
    enabled: /^[A-Z]{3}$/.test(base),
    queryFn: async ({ signal }) =>
      unwrap(await api.GET('/api/v1/exchange-rate-overrides', { signal, params: { query: { base } } })),
  });
  const remove = useMutation({
    mutationFn: async (value: Override) => {
      if (attempt.current.id !== value.id)
        attempt.current = { id: value.id, mutationId: crypto.randomUUID(), at: new Date().toISOString() };
      await pushChange({
        entity_type: 'exchange_rate_override',
        entity_id: value.id,
        ledger_id: null,
        mutation_id: attempt.current.mutationId,
        updated_at: attempt.current.at,
        action: 'delete',
        payload: {},
      });
    },
    onSuccess: () => setRemoving(null),
  });
  return (
    <>
      {remove.isPending && <PendingOperationGuard />}
      <Dialog
        open
        title="自定义汇率"
        description="这项账号偏好适用于你的记账折算，不会覆盖已有支出的历史金额。"
        onClose={() => {
          if (!remove.isPending) onClose();
        }}
      >
        <div className="stack">
          <Field label="折算本位币" hint="例如 CNY。汇率含义为：1 原币 = 所填数值的本位币。">
            <input maxLength={3} value={base} onChange={(event) => setBase(event.target.value.toUpperCase())} />
          </Field>
          {!/^[A-Z]{3}$/.test(base) ? (
            <p className="muted">请输入完整的三位币种代码。</p>
          ) : records.isPending ? (
            <LoadingState />
          ) : records.isError ? (
            <ErrorState error={records.error} retry={() => void records.refetch()} />
          ) : records.data.length === 0 ? (
            <EmptyState
              title="这个币种还没有手动汇率"
              description="折算时可使用服务端提供的参考汇率，也可在此保存自己的汇率。"
            />
          ) : (
            <ul className="category-list">
              {records.data.map((rate) => (
                <li key={rate.id} className="stack">
                  <strong>
                    1 {rate.quote_currency} = {rate.rate} {rate.base_currency}
                  </strong>
                  <span className="muted">更新于 {new Date(rate.updated_at).toLocaleString('zh-CN')}</span>
                  <div className="toolbar">
                    <Button variant="secondary" onClick={() => setEditing(rate)}>
                      编辑 {rate.quote_currency}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        remove.reset();
                        setRemoving(rate);
                      }}
                    >
                      恢复 {rate.quote_currency} 自动汇率
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <Button disabled={!/^[A-Z]{3}$/.test(base)} onClick={() => setEditing('new')}>
            添加自定义汇率
          </Button>
        </div>
      </Dialog>
      {editing && (
        <RateEditor base={base} value={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />
      )}
      <Dialog
        open={removing !== null}
        title="恢复自动汇率？"
        description={
          removing
            ? `移除 1 ${removing.quote_currency} 对 ${removing.base_currency} 的手动覆盖，之后可使用自动参考汇率。历史支出保持不变。`
            : undefined
        }
        onClose={() => {
          if (!remove.isPending) setRemoving(null);
        }}
      >
        {remove.isError && <ErrorState error={remove.error} />}
        <div className="toolbar">
          <Button
            disabled={remove.isPending}
            onClick={() => {
              if (removing) remove.mutate(removing);
            }}
          >
            {remove.isPending ? '处理中…' : '确认恢复自动'}
          </Button>
        </div>
      </Dialog>
    </>
  );
}

/** 同一币种对使用稳定实体 ID；编辑只变更汇率，避免遗留旧币种对的覆盖。 */
function RateEditor({ base, value, onClose }: { base: string; value?: Override; onClose: () => void }) {
  const { session } = useSession();
  const [quote, setQuote] = useState(value?.quote_currency ?? '');
  const [rate, setRate] = useState(value?.rate ?? '');
  const [validation, setValidation] = useState('');
  const attempt = useRef({ signature: '', mutationId: crypto.randomUUID(), at: new Date().toISOString() });
  const save = useMutation({
    mutationFn: async (normalized: string) => {
      const signature = `${base}:${quote}:${normalized}`;
      if (signature !== attempt.current.signature)
        attempt.current = { signature, mutationId: crypto.randomUUID(), at: new Date().toISOString() };
      const id = await exchangeRateOverrideId(session!.user.user_id, base, quote);
      await pushChange({
        entity_type: 'exchange_rate_override',
        entity_id: id,
        ledger_id: null,
        mutation_id: attempt.current.mutationId,
        updated_at: attempt.current.at,
        action: 'upsert',
        payload: { base_currency: base, quote_currency: quote, rate: normalized },
      });
    },
    onSuccess: completeSave,
  });
  const dirty = quote !== (value?.quote_currency ?? '') || rate !== (value?.rate ?? '');
  const { close, finish, confirmation } = useDraftClose(dirty, save.isPending, onClose);
  /** 写入成功才放行关闭。 */
  function completeSave() {
    finish();
  }
  return (
    <Dialog open title={value ? '编辑自定义汇率' : '添加自定义汇率'} onClose={close}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          const normalized = canonicalRate(rate);
          if (!/^[A-Z]{3}$/.test(quote) || quote === base || !normalized) {
            setValidation('请输入与本位币不同的三位原币代码及有效正汇率。');
            return;
          }
          setValidation('');
          save.mutate(normalized);
        }}
      >
        <Field label="原币代码">
          <input
            maxLength={3}
            readOnly={Boolean(value) || save.isPending}
            value={quote}
            onChange={(event) => setQuote(event.target.value.toUpperCase())}
          />
        </Field>
        <Field label={`1 ${quote || '原币'} = 多少 ${base}`} hint="最多 20 位整数、18 位小数。">
          <input
            inputMode="decimal"
            readOnly={save.isPending}
            value={rate}
            onChange={(event) => setRate(event.target.value)}
          />
        </Field>
        {validation && (
          <p role="alert" className="error-text">
            {validation}
          </p>
        )}
        {save.isError && <ErrorState error={save.error} />}
        <div className="toolbar">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? '保存中…' : '保存汇率'}
          </Button>
        </div>
      </form>
      {confirmation}
    </Dialog>
  );
}
