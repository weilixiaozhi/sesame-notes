import { useId, useRef, useState, type Ref } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Button, Dialog, Field } from '../../components/ui';
import { isMobileDialogViewport } from '../../lib/use-dialog-viewport';
import catalog from './currency-catalog.json';
import './currency-picker.css';

const commonRanks = new Map(catalog.commonCodes.map((code, index) => [code, index]));
const currenciesByCode = new Map(catalog.currencies.map((currency) => [currency.code, currency]));

/** 从统一目录筛选币种，当前选择与常用币种优先，其余保留目录顺序。 */
function currencyChoices(current: string, search: string) {
  const query = search.trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
  return catalog.currencies
    .filter((currency) =>
      [currency.code, currency.name, currency.englishName, currency.symbol].some((value) =>
        value.normalize('NFKC').toLocaleLowerCase('zh-CN').includes(query),
      ),
    )
    .sort((left, right) => {
      const leftRank = left.code === current ? -1 : (commonRanks.get(left.code) ?? catalog.commonCodes.length);
      const rightRank = right.code === current ? -1 : (commonRanks.get(right.code) ?? catalog.commonCodes.length);
      return leftRank - rightRank;
    });
}

/** 搜索只过滤选项；点击目录内的币种后才更新表单值，关闭弹窗不会改变原值。 */
export function CurrencyPicker({
  label,
  value,
  onChange,
  onBlur,
  triggerRef,
  disabled = false,
  hint,
  error,
}: {
  label: string;
  value: string;
  onChange: (code: string) => void;
  onBlur?: () => void;
  triggerRef?: Ref<HTMLButtonElement>;
  disabled?: boolean;
  hint?: string;
  error?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selectionError, setSelectionError] = useState('');
  const choices = currencyChoices(value, search);
  const selected = currenciesByCode.get(value);
  const firstChoice = useRef<HTMLButtonElement>(null);
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;

  /** 只提交目录中的完整代码，父表单更新失败时保留选择器并显示错误。 */
  function choose(code: string) {
    try {
      if (disabled || !currenciesByCode.has(code)) return;
      onChange(code);
      setOpen(false);
    } catch (cause) {
      console.error('选择币种失败', { code, cause });
      setSelectionError('暂时无法选择币种，请重试。');
    }
  }

  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor={id}>
          {label}
        </label>
        <Button
          id={id}
          ref={triggerRef}
          variant="secondary"
          className="currency-picker-trigger"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-describedby={describedBy}
          aria-invalid={Boolean(error)}
          disabled={disabled}
          onBlur={onBlur}
          onClick={() => {
            setSearch('');
            setSelectionError('');
            setOpen(true);
          }}
        >
          <span>{selected ? `${selected.name}（${selected.code}）` : value || '请选择币种'}</span>
          <ChevronDown size={18} aria-hidden="true" />
        </Button>
        {hint && (
          <span id={`${id}-hint`} className="field-hint">
            {hint}
          </span>
        )}
        {error && (
          <span id={`${id}-error`} role="alert" className="field-error">
            {error}
          </span>
        )}
      </div>
      <Dialog open={open} mobileFullscreen title="选择币种" onClose={() => setOpen(false)}>
        <div className="stack">
          <Field label="搜索币种">
            <input
              autoFocus={!isMobileDialogViewport()}
              type="search"
              autoComplete="off"
              placeholder="搜索名称、代码或符号"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                // 搜索框内回车不能提交外层账本表单；唯一匹配项可直接选中。
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (choices.length === 1) choose(choices[0]!.code);
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  firstChoice.current?.focus();
                }
              }}
            />
          </Field>
          <p className="muted" role="status">
            {choices.length ? `可选 ${choices.length} 种币种` : '没有匹配的币种，请换个名称或代码搜索。'}
          </p>
          <ul className="currency-picker-list" aria-label="币种列表">
            {choices.map((currency, index) => (
              <li key={currency.code}>
                <Button
                  ref={index === 0 ? firstChoice : undefined}
                  variant="ghost"
                  className="currency-picker-choice"
                  aria-label={`${currency.name}（${currency.code}）`}
                  aria-pressed={value === currency.code}
                  disabled={disabled}
                  onClick={() => choose(currency.code)}
                >
                  <bdi className="currency-picker-symbol">{currency.symbol}</bdi>
                  <span className="currency-picker-name">
                    <span>{currency.name}</span>
                    <span className="muted">{currency.code}</span>
                  </span>
                  {value === currency.code && <Check size={18} aria-hidden="true" />}
                </Button>
              </li>
            ))}
          </ul>
          {selectionError && (
            <p role="alert" className="error-text">
              {selectionError}
            </p>
          )}
        </div>
      </Dialog>
    </>
  );
}
