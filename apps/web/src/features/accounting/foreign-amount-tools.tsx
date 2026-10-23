import { useEffect, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { unwrap } from '@sesame-notes/api-client';
import { captureSessionOperation } from '../../lib/session';
import { Button, ErrorState } from '../../components/ui';
import { canonicalEntryAmount } from './money';
import { convertAmount, inverseRate } from './currency-math';

/** 用户主动折算时优先采用账号手动汇率，既有历史折算金额不会被后台刷新覆盖。 */
export function ForeignAmountTools({
  amount,
  currency,
  base,
  disabled,
  onApply,
  onPendingChange,
}: {
  amount: string;
  currency: string;
  base: string;
  disabled: boolean;
  onApply: (amount: string) => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const active = useRef<AbortController | null>(null);
  const current = useRef({ amount, currency, base, onApply });
  current.current = { amount, currency, base, onApply };
  useEffect(() => () => active.current?.abort(), []);
  const convert = useMutation({
    mutationFn: async () => {
      const operation = captureSessionOperation();
      const api = operation.client;
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      const signal = AbortSignal.any([controller.signal, operation.signal]);
      const snapshot = { amount, currency, base };
      const overrides = unwrap(
        await api.GET('/api/v1/exchange-rate-overrides', {
          signal,
          params: { query: { base } },
        }),
      );
      const manual = overrides.find((item) => item.quote_currency === currency);
      let rate = manual?.rate;
      let source = '账号自定义汇率';
      if (!rate) {
        const automatic = unwrap(
          await api.GET('/api/v1/exchange-rates', {
            signal,
            params: { query: { base } },
          }),
        );
        const value = automatic.rates[currency];
        if (!value) throw new Error(`暂时没有 ${currency} 对 ${base} 的参考汇率，请手动填写折算金额。`);
        rate = inverseRate(value);
        source = `${automatic.source} · ${automatic.rate_date ?? new Date(automatic.fetched_at).toLocaleDateString('zh-CN')}`;
      }
      const converted = convertAmount(amount, rate, 2);
      operation.assertCurrent();
      if (signal.aborted) throw new DOMException('已取消折算', 'AbortError');
      if (
        current.current.amount !== snapshot.amount ||
        current.current.currency !== snapshot.currency ||
        current.current.base !== snapshot.base
      )
        throw new Error('金额或币种已改变，请再次折算。');
      current.current.onApply(converted);
      return `1 ${currency} = ${rate} ${base} · ${source}`;
    },
  });
  useEffect(() => {
    onPendingChange?.(convert.isPending);
    return () => onPendingChange?.(false);
  }, [convert.isPending, onPendingChange]);
  return (
    <div className="stack">
      <Button
        variant="secondary"
        disabled={disabled || convert.isPending || !canonicalEntryAmount(amount) || !/^[A-Z]{3}$/.test(currency)}
        onClick={() => convert.mutate()}
      >
        {convert.isPending ? '正在折算…' : '按当前汇率填写折算金额'}
      </Button>
      {convert.data && <p className="muted">{convert.data}</p>}
      {convert.isError && <ErrorState error={convert.error} />}
    </div>
  );
}
