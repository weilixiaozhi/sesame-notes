import { useEffect, useRef, useState } from 'react';
import { Field } from '../../../components/ui';
import { parseDelimited } from '../../../lib/delimited-text';

/** 表格软件可能忽略开头空白后执行公式；原始单引号内容保持原样。 */
function formulaLike(value: string): boolean {
  if (/^[\t\r\n]/u.test(value)) return true;
  let index = 0;
  while (index < value.length && (value.charCodeAt(index) <= 0x20 || /\s/u.test(value[index]!))) index++;
  const first = value[index];
  return first !== undefined && '=+-@＝＋－＠'.includes(first);
}

/** 从原值 CSV 生成表格查看副本，仅修改存在公式执行风险的单元格。 */
export function inspectCsv(text: string): { safeText: string; riskyCells: number } {
  const rows = parseDelimited(text, ',');
  let riskyCells = 0;
  const cell = (value: string) => {
    const content = formulaLike(value) ? (riskyCells++, `'${value}`) : value;
    return /[",\r\n]/u.test(content) ? `"${content.replaceAll('"', '""')}"` : content;
  };
  const safeText = `${text.startsWith('\uFEFF') ? '\uFEFF' : ''}${rows.map((row) => row.map(cell).join(',')).join('\r\n')}`;
  return { safeText, riskyCells };
}

/** 原值导出确认绑定完整内容；重新读取或范围变化后不能复用旧确认。 */
export function useCsvDownload() {
  const [mode, setMode] = useState<'safe' | 'raw'>('safe');
  const [review, setReview] = useState<{ text: string; count: number; accepted: boolean } | null>(null);
  const warning = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (review && !review.accepted) {
      warning.current?.focus({ preventScroll: true });
      warning.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [review]);
  /** 返回 null 表示必须先核对当前文件的原值风险，不触发下载。 */
  function prepare(text: string): string | null {
    const inspected = inspectCsv(text);
    if (mode === 'safe') return inspected.safeText;
    if (!inspected.riskyCells) return text;
    if (review?.text === text && review.accepted) return text;
    setReview({ text, count: inspected.riskyCells, accepted: false });
    return null;
  }
  const controls = (
    <div className="stack">
      <Field label="CSV 用途">
        <select
          value={mode}
          onChange={(event) => {
            setMode(event.target.value as 'safe' | 'raw');
            setReview(null);
          }}
        >
          <option value="safe">表格安全 CSV（用于查看）</option>
          <option value="raw">原值 CSV（用于导入）</option>
        </select>
      </Field>
      <p className="muted">
        表格安全 CSV 会在可能被当作公式的文本前加单引号，这些单元格内容会改变。跨端重新导入请选原值
        CSV；不会自动删除原文中的单引号。
      </p>
      {mode === 'raw' && review && (
        <div className="notice stack" ref={warning} tabIndex={-1} role="alert">
          <p>
            此文件有 {review.count} 个单元格可能被表格软件当作公式执行。原值 CSV
            用于数据导入，请不要直接用表格软件打开；查看请选表格安全 CSV。
          </p>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={review.accepted}
              onChange={(event) => setReview({ ...review, accepted: event.target.checked })}
            />
            我已了解风险，仍下载保留原始内容的 CSV。
          </label>
        </div>
      )}
    </div>
  );
  return { prepare, controls };
}
