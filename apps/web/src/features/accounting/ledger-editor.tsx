import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { unwrap, type components } from '@sesame-notes/api-client';
import { api, queryClient } from '../../lib/session';
import { useDraftClose } from '../../components/use-draft-close';
import { Button, Dialog, ErrorState, Field } from '../../components/ui';
import { createLedgerSubmitter } from './entity-submit';
import { CurrencyPicker } from './currency-picker';
type Ledger = components['schemas']['Ledger'];
const nameInput = z.string().trim().min(1, '请输入名称').max(100, '名称最多 100 个字符');
const ledgerFormSchema = z.object({
  name: nameInput,
  currency: z.string().regex(/^[A-Z]{3}$/, '请选择币种'),
  monthStartDay: z
    .number({ error: '请输入 1 到 31 之间的整数' })
    .int('请输入整数')
    .min(1, '最小为 1 日')
    .max(31, '最大为 31 日'),
  aaEnabled: z.boolean(),
});
type LedgerFormValues = z.infer<typeof ledgerFormSchema>;
/** 新建与账本设置共用表单；修改本位币由独立的原子重算流程处理。 */
export function LedgerEditor({
  accountId,
  ledger,
  onClose,
  onSaved,
}: {
  accountId: string;
  ledger?: Ledger;
  onClose: () => void;
  onSaved: (ledger: Ledger) => void;
}) {
  const form = useForm<LedgerFormValues>({
    resolver: zodResolver(ledgerFormSchema),
    defaultValues: {
      name: ledger?.name ?? '',
      currency: ledger?.currency ?? 'CNY',
      monthStartDay: ledger?.month_start_day ?? 1,
      aaEnabled: ledger?.aa_enabled ?? false,
    },
  });
  const [submitNew] = useState(() => createLedgerSubmitter());
  const save = useMutation({
    mutationFn: async (values: LedgerFormValues) =>
      ledger
        ? unwrap(
            await api.PATCH('/api/v1/ledgers/{ledger_id}', {
              params: { path: { ledger_id: ledger.id } },
              body: { name: values.name, month_start_day: values.monthStartDay, aa_enabled: values.aaEnabled },
            }),
          )
        : submitNew({
            name: values.name,
            currency: values.currency,
            month_start_day: values.monthStartDay,
            aa_enabled: values.aaEnabled,
          }),
    onSuccess: completeSave,
  });
  const { close, confirmation, finish } = useDraftClose(form.formState.isDirty, save.isPending, onClose);
  /** 完成权威数据刷新后放行成功退出，避免草稿保护拦截程序内导航。 */
  async function completeSave(saved: Ledger) {
    // 首次创建可在服务端原子初始化账号分类；同账号其他账本也共用这份目录。
    await queryClient.invalidateQueries({
      queryKey: ['account', accountId, 'accounting'],
      predicate: ({ queryKey }) => queryKey[3] === 'ledgers' || (!ledger && queryKey[4] === 'categories'),
    });
    finish(() => onSaved(saved));
  }

  return (
    <Dialog
      open
      title={ledger ? '账本设置' : '新建云端账本'}
      description={ledger ? '名称、账期与 AA 设置会同步到其他设备。' : '账本保存到当前账号，可在手机和网页上访问。'}
      onClose={close}
    >
      <form className="stack" onSubmit={form.handleSubmit((values) => save.mutateAsync(values).catch(() => undefined))}>
        <fieldset disabled={save.isPending} className="stack" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <Field label="账本名称" error={form.formState.errors.name?.message}>
            <input
              autoFocus
              autoComplete="off"
              placeholder="例如：日常生活"
              maxLength={100}
              {...form.register('name')}
            />
          </Field>
          {!ledger && (
            <Controller
              control={form.control}
              name="currency"
              render={({ field, fieldState }) => (
                <CurrencyPicker
                  label="本位币"
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  triggerRef={field.ref}
                  disabled={save.isPending}
                  error={fieldState.error?.message}
                />
              )}
            />
          )}
          <Field
            label="每月账期起始日"
            error={form.formState.errors.monthStartDay?.message}
            hint="遇到不足该日期的月份，使用当月最后一天。"
          >
            <input type="number" min={1} max={31} {...form.register('monthStartDay', { valueAsNumber: true })} />
          </Field>
          <label className="checkbox-field">
            <input type="checkbox" {...form.register('aaEnabled')} />
            开启 AA 统计
          </label>
          {save.isError && <ErrorState error={save.error} />}
          <div className="toolbar">
            <Button type="submit" disabled={save.isPending || form.formState.isSubmitting}>
              {save.isPending ? '保存中…' : '保存账本'}
            </Button>
          </div>
        </fieldset>
      </form>
      {confirmation}
    </Dialog>
  );
}
