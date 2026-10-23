import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useFieldArray, type UseFormReturn } from 'react-hook-form';
import { Plus, Trash2 } from 'lucide-react';
import { unwrap, type components } from '@sesame-notes/api-client';
import { api, useSession } from '../../lib/session';
import { Button, ErrorState, Field, LoadingState } from '../../components/ui';
import { canonicalEntryAmount, displayAmount } from './money';
import type { TransactionFormValues } from './transaction-form-schema';
import { equalAmounts } from './aa-money';

/** AA 输入使用交易原币，所有参与者使用服务端成员 ID；历史注册成员仍可保留引用。 */
export function AaFields({
  form,
  ledger,
  existing,
  defaultPayerId,
  pending,
}: {
  form: UseFormReturn<TransactionFormValues>;
  ledger: components['schemas']['Ledger'];
  existing?: components['schemas']['Transaction'];
  defaultPayerId?: string;
  pending: boolean;
}) {
  const { session } = useSession();
  const [splitError, setSplitError] = useState('');
  const members = useQuery({
    queryKey: ['account', session?.user.user_id, 'accounting', ledger.id, 'participants'],
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/ledgers/{ledger_id}/participants', {
          signal,
          params: { path: { ledger_id: ledger.id } },
        }),
      ),
  });
  const { fields, append, remove, replace } = useFieldArray({ control: form.control, name: 'splits' });
  const mode = form.watch('aaMode');
  const values = form.watch();
  const originalAmount = canonicalEntryAmount(values.amount);
  const previouslyUsed = new Set([
    existing?.payer_member_id,
    ...(existing?.splits.map((split) => split.member_id) ?? []),
  ]);
  const available = (members.data ?? []).filter(
    (member) => member.status === 'ACTIVE' || (member.member_type === 'REGISTERED' && previouslyUsed.has(member.id)),
  );
  const used = new Set(values.splits.map((split) => split.memberId));
  const remaining = available.filter((member) => !used.has(member.id));
  return (
    <details className="stack" open>
      <summary>分摊</summary>
      {members.isPending ? (
        <LoadingState label="正在读取账本成员…" />
      ) : members.isError ? (
        <ErrorState error={members.error} retry={() => void members.refetch()} />
      ) : (
        <div className="stack">
          <Field label="支出人">
            <select {...form.register('payerId')} disabled={pending}>
              <option value="">本人（默认）</option>
              {values.payerId && !available.some((member) => member.id === values.payerId) && (
                <option value={values.payerId}>原付款成员已不可用，请重新选择</option>
              )}
              {available.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.display_name}
                  {member.member_type === 'PLACEHOLDER' ? ' · 虚拟成员' : ''}
                  {member.status !== 'ACTIVE' ? ' · 已退出' : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="分摊方式">
            <select {...form.register('aaMode')} disabled={pending}>
              <option value="0">人均分摊</option>
              <option value="1">不分摊</option>
              <option value="2">指定分摊</option>
            </select>
          </Field>
          {mode === '2' && (
            <>
              <p className="muted">
                分摊使用 {values.currency}，合计应为 {originalAmount ? displayAmount(originalAmount) : '—'}。
              </p>
              {fields.map((field, index) => (
                <div className="form-grid" key={field.id}>
                  <Field label={`参与成员 ${index + 1}`}>
                    <select {...form.register(`splits.${index}.memberId`)} disabled={pending}>
                      <option value="">请选择成员</option>
                      {available
                        .filter((member) => !used.has(member.id) || values.splits[index]?.memberId === member.id)
                        .map((member) => (
                          <option key={member.id} value={member.id}>
                            {member.display_name}
                            {member.status !== 'ACTIVE' ? ' · 已退出' : ''}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label={`分摊金额 ${index + 1} · ${values.currency}`}>
                    <input inputMode="decimal" {...form.register(`splits.${index}.amount`)} readOnly={pending} />
                  </Field>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    aria-label={`移除参与成员 ${index + 1}`}
                    onClick={() => remove(index)}
                  >
                    <Trash2 size={16} />
                    移除
                  </Button>
                </div>
              ))}
              <div className="toolbar">
                <Button
                  variant="secondary"
                  disabled={pending || remaining.length === 0 || fields.length >= 100}
                  onClick={() => append({ memberId: remaining[0]?.id ?? '', amount: '' })}
                >
                  <Plus size={16} />
                  添加参与人
                </Button>
                <Button
                  variant="secondary"
                  disabled={pending || fields.length === 0 || !originalAmount || (!values.payerId && !defaultPayerId)}
                  onClick={() => {
                    try {
                      if (!originalAmount) return;
                      const shares = equalAmounts(
                        originalAmount,
                        fields.length,
                        values.splits.findIndex((split) => split.memberId === (values.payerId || defaultPayerId)),
                      );
                      replace(values.splits.map((split, index) => ({ ...split, amount: shares[index] ?? '' })));
                      setSplitError('');
                      form.clearErrors('root.aa');
                    } catch (error) {
                      setSplitError(
                        error instanceof Error ? error.message : '无法分配金额，请检查参与人数与支出金额。',
                      );
                    }
                  }}
                >
                  按当前参与人均分
                </Button>
              </div>
              {splitError && (
                <p role="alert" className="error-text">
                  {splitError}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </details>
  );
}
