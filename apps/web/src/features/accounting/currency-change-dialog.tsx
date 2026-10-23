import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { unwrap, type components } from '@sesame-notes/api-client';
import { api, queryClient, useSession } from '../../lib/session';
import { useDraftClose } from '../../components/use-draft-close';
import { Button, Dialog, ErrorState, Field, LoadingState } from '../../components/ui';
import { canonicalRate, inverseRate } from './currency-math';
import { CurrencyPicker } from './currency-picker';

/** 原子更换账本本位币：先显示影响范围与汇率，再由服务端一次性重算金额和 AA 分摊。 */
export function CurrencyChangeDialog({
  ledger,
  onClose,
}: {
  ledger: components['schemas']['Ledger'];
  onClose: () => void;
}) {
  const { session } = useSession();
  const [currency, setCurrency] = useState(ledger.currency);
  const [rates, setRates] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [validation, setValidation] = useState('');
  const attempt = useRef({ signature: '', key: crypto.randomUUID() });
  const stats = useQuery({
    queryKey: ['account', session?.user.user_id, 'accounting', ledger.id, 'currency-change-impact'],
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/ledgers/{ledger_id}/transaction-stats', {
          signal,
          params: { path: { ledger_id: ledger.id } },
        }),
      ),
  });
  const sources = stats.data?.by_currency.map((item) => item.currency_code).filter((code) => code !== currency) ?? [];
  const reference = useMutation({
    mutationFn: async () => {
      const result = unwrap(await api.GET('/api/v1/exchange-rates', { params: { query: { base: currency } } }));
      const filled: Record<string, string> = {};
      for (const source of sources) {
        const value = result.rates[source];
        if (!value) throw new Error(`缺少 ${source} 对 ${currency} 的参考汇率，请手动填写。`);
        filled[source] = inverseRate(value);
      }
      setRates(filled);
      setConfirmed(false);
      return result;
    },
  });
  const save = useMutation({
    mutationFn: async () => {
      const normalized: Record<string, string> = {};
      for (const source of sources) {
        const value = canonicalRate(rates[source] ?? '');
        if (!value) throw new Error(`请填写 ${source} 对 ${currency} 的有效正汇率。`);
        normalized[source] = value;
      }
      const body = { currency, expected_currency: ledger.currency, rates: normalized };
      const signature = JSON.stringify(body);
      if (attempt.current.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };
      return unwrap(
        await api.POST('/api/v1/ledgers/{ledger_id}/change-currency', {
          params: { path: { ledger_id: ledger.id }, header: { 'idempotency-key': attempt.current.key } },
          body,
        }),
      );
    },
    onSuccess: completeSave,
  });
  const pending = save.isPending || reference.isPending;
  const { close, finish, confirmation } = useDraftClose(
    currency !== ledger.currency || Object.keys(rates).length > 0,
    pending,
    onClose,
  );
  /** 完成权威数据刷新后放行成功退出，避免草稿保护拦截程序内导航。 */
  async function completeSave() {
    await queryClient.invalidateQueries({ queryKey: ['account', session?.user.user_id] });
    finish();
  }

  return (
    <Dialog
      open
      title="更换账本本位币"
      description="所有历史支出的原币金额会保留；折算金额和 AA 分摊将按你确认的汇率重新计算。"
      onClose={close}
    >
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!/^[A-Z]{3}$/.test(currency) || currency === ledger.currency) {
            setValidation('请选择与当前不同的币种。');
            return;
          }
          if (!confirmed) {
            setValidation('请确认重算影响后继续。');
            return;
          }
          setValidation('');
          save.mutate();
        }}
      >
        <CurrencyPicker
          label="新的本位币"
          hint={`当前本位币：${ledger.currency}`}
          value={currency}
          disabled={pending}
          onChange={(code) => {
            if (code === currency) return;
            setCurrency(code);
            setRates({});
            setConfirmed(false);
            setValidation('');
            reference.reset();
          }}
        />
        {stats.isPending ? (
          <LoadingState label="正在统计受影响的记录…" />
        ) : stats.isError ? (
          <ErrorState error={stats.error} retry={() => void stats.refetch()} />
        ) : (
          <>
            <p>将重新计算 {stats.data.transaction_count} 笔支出。</p>
            {sources.map((source) => (
              <Field key={source} label={`1 ${source} = 多少 ${currency}`}>
                <input
                  inputMode="decimal"
                  value={rates[source] ?? ''}
                  readOnly={pending}
                  onChange={(event) => {
                    setRates({ ...rates, [source]: event.target.value });
                    setConfirmed(false);
                  }}
                />
              </Field>
            ))}
            {sources.length > 0 && (
              <Button
                variant="secondary"
                disabled={pending || !/^[A-Z]{3}$/.test(currency) || currency === ledger.currency}
                onClick={() => reference.mutate()}
              >
                {reference.isPending ? '正在读取汇率…' : '填入参考汇率'}
              </Button>
            )}
            {reference.data && (
              <p className="muted">
                参考来源：{reference.data.source} · 汇率日期{' '}
                {reference.data.rate_date ?? new Date(reference.data.fetched_at).toLocaleDateString('zh-CN')}
                。请核对后再确认。
              </p>
            )}
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={pending || currency === ledger.currency}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              我已确认汇率，了解历史折算金额与 AA 分摊将重新计算。
            </label>
          </>
        )}
        {validation && (
          <p role="alert" className="error-text">
            {validation}
          </p>
        )}
        {reference.isError && <ErrorState error={reference.error} />}
        {save.isError && <ErrorState error={save.error} />}
        <div className="toolbar">
          <Button type="submit" disabled={pending || !stats.data || !confirmed}>
            {save.isPending ? '正在重算…' : '确认更换并重算'}
          </Button>
        </div>
      </form>
      {confirmation}
    </Dialog>
  );
}
