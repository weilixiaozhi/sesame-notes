import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { unwrap, type components } from '@sesame-notes/api-client';
import { api, useSession } from '../../lib/session';
import { useDraftClose } from '../../components/use-draft-close';
import { isMobileDialogViewport } from '../../lib/use-dialog-viewport';
import { useProductAnalyticsPage } from '../../lib/use-product-analytics';
import {
  captureProductAnalyticsContext,
  trackProductAction,
  type ProductAnalyticsContext,
} from '../../lib/product-analytics-runtime';
import { Button, Dialog, ErrorState, Field } from '../../components/ui';
import { canonicalEntryAmount, localDateTime, roundEntryAmount, sumAmounts } from './money';
import { AaFields } from './aa-fields';
import { convertSplitAmounts } from './aa-money';
import { ForeignAmountTools } from './foreign-amount-tools';
import { createTransactionSubmitter } from './transaction-submit';
import { createTransactionUpdater, TransactionEditConflict } from './transaction-update';
import { entryNoteCharacters, transactionFormSchema, type TransactionFormValues } from './transaction-form-schema';
import { CurrencyPicker } from './currency-picker';
import { TransactionCategoryPicker } from './transaction-category-picker';
import './transaction-editor.css';
type Ledger = components['schemas']['Ledger'];
type Transaction = components['schemas']['Transaction'];
type Category = components['schemas']['Category'];

/** 金额以十进制字符串提交，编辑携带原始版本并保持周期来源字段不变。 */
export function TransactionEditor({
  ledger,
  existing,
  analyticsContext,
  categories,
  categoriesLoading,
  categoriesError,
  retryCategories,
  onClose,
  onSaved,
}: {
  ledger: Ledger;
  existing?: Transaction;
  analyticsContext?: ProductAnalyticsContext | null;
  categories: Category[];
  categoriesLoading: boolean;
  categoriesError: unknown;
  retryCategories: () => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { session } = useSession();
  const formId = useId();
  useProductAnalyticsPage('accounting.transaction.editor', true, 2, analyticsContext);
  const saveContext = useRef<ProductAnalyticsContext | null>(null);
  const [editBase, setEditBase] = useState(existing);
  const availableCategories = useMemo(
    () =>
      categories
        .filter((category) => category.deleted_at === null)
        .sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name)),
    [categories],
  );
  const firstCategory = availableCategories.find((category) => category.level === 1 && category.parent_id === null);
  const categoriesReady = !categoriesLoading && !categoriesError;
  const initialCategoryId = existing?.category_id ?? (!existing && categoriesReady ? firstCategory?.id : '') ?? '';
  const categoryInitialized = useRef(!!existing || !!initialCategoryId);
  const composingNote = useRef(false);
  const [initialSplits] = useState(() => {
    if (!existing?.splits.length) return [];
    const amounts = convertSplitAmounts(
      existing.splits.map((split) => split.amount),
      existing.native_amount,
      roundEntryAmount(existing.amount),
      existing.splits.findIndex((split) => split.member_id === existing.payer_member_id),
      2,
    );
    return existing.splits.map((split, index) => ({ memberId: split.member_id, amount: amounts[index]! }));
  });
  const form = useForm<TransactionFormValues>({
    resolver: zodResolver(transactionFormSchema),
    defaultValues: {
      amount: existing ? roundEntryAmount(existing.amount) : '',
      nativeAmount: existing ? roundEntryAmount(existing.native_amount) : '',
      currency: existing?.currency_code ?? ledger.currency,
      happenedAt: localDateTime(existing?.happened_at ?? new Date()),
      categoryId: initialCategoryId,
      note: existing?.note ?? '',
      payerId: existing?.payer_member_id ?? '',
      aaMode: existing?.aa_mode ?? '0',
      splits: initialSplits,
    },
  });
  const [submitter] = useState(() =>
    existing
      ? createTransactionUpdater(ledger, existing, session!.user.user_id)
      : createTransactionSubmitter(ledger, session!.user.user_id),
  );
  const [reviewError, setReviewError] = useState<unknown>(null);
  const members = useQuery({
    queryKey: ['account', session?.user.user_id, 'accounting', ledger.id, 'shared-members'],
    enabled: ledger.aa_enabled,
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/ledgers/{ledger_id}/members', { signal, params: { path: { ledger_id: ledger.id } } }),
      ),
  });
  const defaultPayerId = members.data?.find((member) => member.user_id === session?.user.user_id)?.member_id;
  const currency = form.watch('currency');
  const enteredAmount = form.watch('amount');
  const categoryId = form.watch('categoryId');
  const [converting, setConverting] = useState(false);
  const missingCategory = !!categoryId && !availableCategories.some((category) => category.id === categoryId);
  const categoryHint = categoriesLoading
    ? '正在加载分类…'
    : categoriesError
      ? '分类加载失败，请重试后保存。'
      : availableCategories.length === 0
        ? ledger.role === 'owner'
          ? '暂无支出分类，请先在分类管理中添加分类。'
          : '暂无支出分类，请联系账本拥有者添加分类。'
        : missingCategory
          ? '所选分类已被删除，请选择其他支出分类。'
          : existing && !categoryId
            ? '这笔支出尚未设置分类，请选择支出分类。'
            : undefined;

  useEffect(() => {
    if (categoryInitialized.current || !categoriesReady || !firstCategory) return;
    // 分类异步到达时只初始化新支出的分类字段，保留金额、备注及用户已经选择的分类。
    if (!form.getValues('categoryId') && !form.getFieldState('categoryId').isDirty) {
      form.resetField('categoryId', { defaultValue: firstCategory.id });
    }
    categoryInitialized.current = true;
  }, [categoriesReady, firstCategory, form]);

  useEffect(() => {
    // 开关变化后重新按当前账本规则校验，隐藏区域不保留失效的分摊错误提示。
    form.clearErrors('root.aa');
  }, [ledger.aa_enabled, form]);

  const save = useMutation({
    mutationFn: async (values: TransactionFormValues) => {
      const amount = canonicalEntryAmount(values.amount);
      const nativeAmount = values.currency === ledger.currency ? amount : canonicalEntryAmount(values.nativeAmount);
      if (!amount || !nativeAmount) throw new Error('请输入有效的支出金额与折算金额。');
      const happenedAt =
        editBase && values.happenedAt === localDateTime(editBase.happened_at)
          ? editBase.happened_at
          : new Date(values.happenedAt).toISOString();
      const payerId = values.payerId || defaultPayerId;
      if (ledger.aa_enabled && values.aaMode === '2' && !payerId)
        throw new Error('暂时无法确认支出人，请等待成员加载完成后重试。');
      const splitAmounts =
        ledger.aa_enabled && values.aaMode === '2'
          ? convertSplitAmounts(
              values.splits.map((split) => canonicalEntryAmount(split.amount)!),
              amount,
              nativeAmount,
              values.splits.findIndex((split) => split.memberId === payerId),
              10,
            )
          : [];
      const body = {
        tx_type: 'expense' as const,
        amount,
        native_amount: nativeAmount,
        currency_code: values.currency,
        happened_at: happenedAt,
        category_id: values.categoryId,
        note: values.note.trim() || null,

        // AA 关闭时不写入隐藏字段；新增付款人由服务端推导，编辑沿用原付款人和分摊信息。
        ...(ledger.aa_enabled
          ? {
              payer_member_id:
                values.payerId ||
                (values.aaMode === '2' ? payerId : editBase?.payer_member_id === null ? undefined : null),
              aa_mode: values.aaMode,
              splits:
                values.aaMode === '2'
                  ? values.splits.map((split, index) => ({
                      member_id: split.memberId,
                      amount: splitAmounts[index]!,
                    }))
                  : [],
            }
          : {}),
      };
      return submitter.submit(body);
    },
    onSuccess: completeSave,
  });
  const { close, confirmation, finish } = useDraftClose(form.formState.isDirty, save.isPending, onClose);

  /** 拼音组合期间保留原始编辑内容，提交候选词后才按可见字符限制长度。 */
  function updateNote(input: HTMLInputElement, complete: boolean) {
    try {
      const value = complete ? entryNoteCharacters(input.value).slice(0, 20).join('') : input.value;
      if (complete) input.value = value;
      form.setValue('note', value, { shouldDirty: true, shouldValidate: complete });
    } catch (error) {
      console.error('更新记账备注输入失败', { ledgerId: ledger.id, error });
      form.setError('note', { message: '备注暂时无法更新，请重新输入。' });
    }
  }
  /** 完成权威数据刷新后放行成功退出，避免草稿保护拦截程序内导航。 */
  async function completeSave() {
    trackProductAction(
      existing ? 'accounting_transaction_updated' : 'accounting_transaction_created',
      'accounting.transaction.editor',
      session?.user.user_id ?? '',
      saveContext.current,
    );
    finish();
    await onSaved();
  }
  const conflict = save.error instanceof TransactionEditConflict ? save.error : null;
  const saveDisabled =
    save.isPending ||
    converting ||
    form.formState.isSubmitting ||
    !!conflict ||
    !categoriesReady ||
    availableCategories.length === 0;

  /** 用户核对云端内容后，仅更新乐观锁基线；草稿继续保留，点击保存时才提交。 */
  function acceptReviewed() {
    try {
      if (!conflict) return;
      submitter.acceptReviewed(conflict.current);
      setEditBase(conflict.current);
      setReviewError(null);
      save.reset();
    } catch (error) {
      console.error('确认支出编辑版本失败', { transactionId: existing?.id, error });
      setReviewError(error);
    }
  }

  return (
    <Dialog
      open
      title="记一笔"
      onClose={close}
      mobileFullscreen
      className="transaction-editor-dialog"
      footer={
        <div className="transaction-editor-actions">
          <Button type="submit" form={formId} disabled={saveDisabled}>
            {save.isPending ? '保存中…' : '完成'}
          </Button>
        </div>
      }
    >
      <form
        id={formId}
        className="stack transaction-editor"
        onSubmitCapture={(event) => {
          if (composingNote.current) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (save.isPending) return;
          saveContext.current = captureProductAnalyticsContext(analyticsContext);
          trackProductAction(
            'accounting_transaction_save_click',
            'accounting.transaction.editor',
            session?.user.user_id ?? '',
            saveContext.current,
          );
        }}
        onSubmit={form.handleSubmit((values) => {
          if (converting) return;
          if (!categoriesReady) {
            form.setError('categoryId', { message: '请等待分类加载成功后再保存。' });
            return;
          }
          if (values.currency !== ledger.currency && !canonicalEntryAmount(values.nativeAmount)) {
            form.setError('nativeAmount', { message: '请输入大于 0 的折算金额，最多 2 位小数' });
            return;
          }
          if (!availableCategories.some((category) => category.id === values.categoryId)) {
            form.setError('categoryId', { message: '所选分类已被删除，请选择其他支出分类。' });
            return;
          }
          const nativeAmount = canonicalEntryAmount(
            values.currency === ledger.currency ? values.amount : values.nativeAmount,
          );
          form.clearErrors('root.aa');
          // 历史自定义分摊保留固定金额，修改总额必须同时核对分摊，不能从隐藏表单静默改写。
          if (
            !ledger.aa_enabled &&
            editBase?.aa_mode === '2' &&
            nativeAmount !== canonicalEntryAmount(editBase.native_amount)
          ) {
            form.setError('root.aa', {
              message: '这笔支出已有自定义 AA 分摊。修改折算后的支出总额前，请先在账本设置中开启 AA 并调整分摊金额。',
            });
            return;
          }
          if (ledger.aa_enabled && values.aaMode === '2') {
            const valid =
              values.splits.length > 0 &&
              values.splits.length <= 100 &&
              values.splits.every((split) => split.memberId && canonicalEntryAmount(split.amount));
            if (
              !valid ||
              new Set(values.splits.map((split) => split.memberId)).size !== values.splits.length ||
              sumAmounts(values.splits.map((split) => canonicalEntryAmount(split.amount)!)) !==
                canonicalEntryAmount(values.amount)
            ) {
              form.setError('root.aa', {
                message: '指定分摊需选择不同成员，每人金额大于 0 且最多 2 位小数，合计必须等于原币支出金额。',
              });
              return;
            }
          }
          return save.mutateAsync(values).catch((error: unknown) => {
            console.error('保存支出失败', { ledgerId: ledger.id, transactionId: existing?.id, error });
          });
        })}
      >
        <fieldset disabled={save.isPending} className="stack transaction-editor-fields">
          <div className="transaction-editor-amount-surface">
            <div className="transaction-editor-amount">
              <Field label="记账金额" error={form.formState.errors.amount?.message}>
                <input
                  autoFocus={!isMobileDialogViewport()}
                  inputMode="decimal"
                  enterKeyHint="done"
                  autoComplete="off"
                  placeholder="输入金额"
                  readOnly={save.isPending}
                  {...form.register('amount')}
                />
              </Field>
            </div>
            <div className="transaction-editor-currency">
              <Controller
                control={form.control}
                name="currency"
                render={({ field, fieldState }) => (
                  <CurrencyPicker
                    label="货币"
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    triggerRef={field.ref}
                    disabled={save.isPending}
                    error={fieldState.error?.message}
                  />
                )}
              />
            </div>
            {enteredAmount.length > 16 && (
              // 输入保留原始精度，完整数值可换行阅读，避免窄屏下只能看见输入框的一部分。
              <div className="transaction-editor-full-amount" aria-hidden="true">
                <span>完整金额</span>
                <strong>{enteredAmount}</strong>
              </div>
            )}
          </div>
          {currency !== ledger.currency && (
            <div className="stack transaction-editor-conversion">
              <Field label={`折合主货币 · ${ledger.currency}`} error={form.formState.errors.nativeAmount?.message}>
                <input inputMode="decimal" readOnly={save.isPending} {...form.register('nativeAmount')} />
              </Field>
              <ForeignAmountTools
                amount={enteredAmount}
                currency={currency}
                base={ledger.currency}
                disabled={save.isPending}
                onPendingChange={setConverting}
                onApply={(value) => form.setValue('nativeAmount', value, { shouldDirty: true, shouldValidate: true })}
              />
            </div>
          )}
          <Controller
            control={form.control}
            name="categoryId"
            render={({ field, fieldState }) => (
              <TransactionCategoryPicker
                categories={availableCategories}
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                triggerRef={field.ref}
                disabled={!categoriesReady || save.isPending}
                hint={categoryHint}
                error={fieldState.error?.message}
              />
            )}
          />
          {categoriesError ? <ErrorState error={categoriesError} retry={retryCategories} /> : null}
          <div className="transaction-editor-details">
            <Field label="记账日期" error={form.formState.errors.happenedAt?.message}>
              <input type="datetime-local" {...form.register('happenedAt')} />
            </Field>
          </div>
          <Field label="备注" error={form.formState.errors.note?.message}>
            <input
              type="text"
              placeholder="备注…"
              {...form.register('note')}
              onCompositionStart={() => {
                composingNote.current = true;
              }}
              onCompositionEnd={(event) => {
                composingNote.current = false;
                updateNote(event.currentTarget, true);
              }}
              onChange={(event) => updateNote(event.currentTarget, !composingNote.current)}
            />
          </Field>
          {ledger.aa_enabled && (
            <div className="transaction-editor-aa">
              <AaFields
                form={form}
                ledger={ledger}
                existing={editBase}
                defaultPayerId={defaultPayerId}
                pending={save.isPending}
              />
              {members.isError && <ErrorState error={members.error} retry={() => void members.refetch()} />}
            </div>
          )}
          {form.formState.errors.root?.aa?.message && (
            <p role="alert" className="error-text">
              {form.formState.errors.root.aa.message}
            </p>
          )}
          {save.isError && <ErrorState error={save.error} />}
          {conflict && (
            <section className="panel stack" aria-label="云端支出版本">
              <strong>请核对云端支出</strong>
              <p>表单保留了你的草稿。请参考下方云端内容调整表单；确认后再次保存，将使用表单中的完整内容。</p>
              <dl>
                <dt>金额</dt>
                <dd>
                  {conflict.current.amount} {conflict.current.currency_code}（折算 {conflict.current.native_amount}{' '}
                  {ledger.currency}）
                </dd>
                <dt>记账日期</dt>
                <dd>{new Date(conflict.current.happened_at).toLocaleString()}</dd>
                <dt>分类</dt>
                <dd>{conflict.current.category_name ?? '未分类'}</dd>
                <dt>备注</dt>
                <dd>{conflict.current.note ?? '无'}</dd>
                <dt>付款人</dt>
                <dd>
                  {conflict.current.payer_member_id
                    ? (conflict.memberNames[conflict.current.payer_member_id] ?? '原付款成员')
                    : '历史默认付款人'}
                </dd>
                <dt>AA 分摊</dt>
                <dd>
                  {conflict.current.aa_mode === '2'
                    ? conflict.current.splits
                        .map((split) => `${conflict.memberNames[split.member_id] ?? '原参与成员'} ${split.amount}`)
                        .join('；')
                    : conflict.current.aa_mode === '1'
                      ? '不参与分摊'
                      : '均摊'}
                </dd>
              </dl>
              <Button variant="secondary" onClick={acceptReviewed}>
                已核对，继续编辑我的草稿
              </Button>
            </section>
          )}
          {!!reviewError && <ErrorState error={reviewError} />}
        </fieldset>
      </form>
      {confirmation}
    </Dialog>
  );
}
