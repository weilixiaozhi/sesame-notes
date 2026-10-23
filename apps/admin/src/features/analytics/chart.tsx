import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { reportError } from '../../api/client';
import { Empty } from '../../components/ui';
import { displayCount, type AnalyticsRange } from './model';

export type AnalyticsPoint = { label: string; shortLabel: string; value: number | null };
const axisCount = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });

/** 统一上海时间显示，与服务端分桶和日期筛选保持相同口径。 */
export function periodLabel(
  value: string,
  bucket: 'hour' | 'day' | 'month',
  full = false,
  range?: AnalyticsRange,
): string {
  try {
    const includeDate = full || bucket !== 'hour' || (range && range.start_date !== range.end_date);
    const includeYear =
      full || bucket === 'month' || (range && range.start_date.slice(0, 4) !== range.end_date.slice(0, 4));
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: includeYear ? 'numeric' : undefined,
      month: includeDate ? '2-digit' : undefined,
      day: bucket !== 'month' && includeDate ? '2-digit' : undefined,
      hour: bucket === 'hour' ? '2-digit' : undefined,
      minute: bucket === 'hour' ? '2-digit' : undefined,
      hourCycle: 'h23',
    }).format(new Date(value));
  } catch (error) {
    console.error('[使用统计] 时间标签无法显示', error instanceof Error ? error.stack : '日期格式无效');
    return '时间不可用';
  }
}

/** 缺失覆盖处断开折线，明细列表与图表共用同一份数值和时间口径。 */
export function AnalyticsChart({
  rows,
  label,
  fractional = false,
}: {
  rows: AnalyticsPoint[];
  label: string;
  fractional?: boolean;
}) {
  const known = rows.flatMap((row) => (row.value === null ? [] : [row.value]));
  const chart = useRef<SVGSVGElement>(null);
  const tooltipId = useId();
  const instructionsId = useId();
  const [width, setWidth] = useState(1000);
  const [selection, setSelection] = useState<{ index: number; rows: AnalyticsPoint[]; label: string } | null>(null);
  const [interactionError, setInteractionError] = useState('');
  // 查询范围或指标变更后，旧数据的定位失效，避免将旧索引误用到新时间序列。
  const activeIndex = selection?.rows === rows && selection.label === label ? selection.index : null;
  const activeRow = activeIndex === null ? undefined : rows[activeIndex];
  const hasData = known.length > 0;
  useEffect(() => {
    let observer: ResizeObserver | undefined;
    try {
      if (!chart.current || typeof ResizeObserver === 'undefined') return;
      // 视口与实际展示宽度一致，窄屏坐标文字保持正常字号，不随整张图缩小。
      observer = new ResizeObserver((entries) => {
        const measuredWidth = entries[0]?.contentRect.width;
        if (measuredWidth) setWidth(Math.max(320, Math.round(measuredWidth)));
      });
      observer.observe(chart.current);
    } catch (error) {
      reportError('analytics-chart-layout', error);
    }
    return () => observer?.disconnect();
  }, [hasData]);
  if (!hasData) return <Empty>所选范围暂无可用的采集数据</Empty>;
  const peak = Math.max(1, ...known);
  // 用 1、2、5 的整倍步长适配峰值，人数与次数保持整数刻度，人均次数允许小数。
  const magnitude = 10 ** Math.floor(Math.log10(peak / 4));
  const niceStep = [1, 2, 5, 10].find((value) => value * magnitude >= peak / 4)! * magnitude;
  const step = fractional ? niceStep : Math.max(1, Math.ceil(niceStep));
  const ceiling = Math.ceil(peak / step) * step;
  const height = 260;
  const left = 64;
  const right = 28;
  const top = 22;
  const bottom = 38;
  const graphWidth = width - left - right;
  const graphHeight = height - top - bottom;
  /** 单点居中，其余点按连续时间序列等距排列。 */
  const x = (index: number) => left + (rows.length === 1 ? graphWidth / 2 : (index / (rows.length - 1)) * graphWidth);
  /** 按统一纵轴上限映射数值，零值保留在底部。 */
  const y = (value: number) => top + (1 - value / ceiling) * graphHeight;
  /** 同一个时间桶内移动只保留现有定位，不重复触发图表渲染。 */
  function selectPoint(index: number): void {
    setSelection((current) =>
      current?.index === index && current.rows === rows && current.label === label ? current : { index, rows, label },
    );
    setInteractionError('');
  }
  /** 使用实际显示尺寸还原坐标，并选择绘图区中离指针最近的时间桶。 */
  function locatePointer(event: PointerEvent<SVGSVGElement>): void {
    try {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const pointerX = ((event.clientX - bounds.left) / bounds.width) * width;
      const pointerY = ((event.clientY - bounds.top) / bounds.height) * height;
      if (pointerX < left || pointerX > width - right || pointerY < top || pointerY > height - bottom) {
        setSelection(null);
        return;
      }
      // 零值与缺失值都占用原来的时间位置，缺失处只显示提示，不伪造折线点。
      selectPoint(rows.length === 1 ? 0 : Math.round(((pointerX - left) / graphWidth) * (rows.length - 1)));
    } catch (error) {
      reportError('analytics-chart-pointer', error);
      setSelection(null);
      setInteractionError('图表定位暂时不可用，请重试。');
    }
  }
  /** 方向键逐点浏览，首尾快捷键跳转，退出键关闭当前数据提示。 */
  function navigatePoints(event: KeyboardEvent<SVGSVGElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      setSelection(null);
      return;
    }
    const index =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? rows.length - 1
          : event.key === 'ArrowLeft'
            ? Math.max(0, (activeIndex ?? rows.length) - 1)
            : event.key === 'ArrowRight'
              ? Math.min(rows.length - 1, (activeIndex ?? -1) + 1)
              : null;
    if (index === null) return;
    event.preventDefault();
    selectPoint(index);
  }
  const segments: string[] = [];
  let line = '';
  rows.forEach((row, index) => {
    if (row.value === null) {
      if (line) segments.push(line);
      line = '';
    } else line += `${line ? ' L' : 'M'}${x(index)} ${y(row.value)}`;
  });
  if (line) segments.push(line);
  const labels = [
    ...new Set(
      width < 600
        ? [0, Math.floor((rows.length - 1) / 2), rows.length - 1]
        : [
            0,
            Math.floor((rows.length - 1) / 4),
            Math.floor((rows.length - 1) / 2),
            Math.floor(((rows.length - 1) * 3) / 4),
            rows.length - 1,
          ],
    ),
  ];
  return (
    <div className="analytics-chart-container">
      <p id={instructionsId} className="sr-only">
        使用左右方向键查看相邻时间的数据，Home 和 End 跳转首尾，Escape 关闭提示。
      </p>
      <div className="analytics-chart-wrap">
        <svg
          ref={chart}
          viewBox={`0 0 ${width} ${height}`}
          className="analytics-chart"
          role="img"
          aria-label={`${label}趋势`}
          aria-describedby={`${instructionsId}${activeRow ? ` ${tooltipId}` : ''}`}
          tabIndex={0}
          onPointerMove={locatePointer}
          onPointerDown={locatePointer}
          onPointerLeave={(event) => {
            if (event.pointerType !== 'touch') setSelection(null);
          }}
          onPointerCancel={() => setSelection(null)}
          onFocus={() => selectPoint(activeIndex ?? 0)}
          onBlur={() => setSelection(null)}
          onKeyDown={navigatePoints}
        >
          {Array.from({ length: Math.round(ceiling / step) + 1 }, (_, index) => index * step).map((value) => (
            <g key={value}>
              <line className="analytics-gridline" x1={left} x2={width - right} y1={y(value)} y2={y(value)} />
              <text x={left - 12} y={y(value) + 4} textAnchor="end">
                {axisCount.format(value)}
              </text>
            </g>
          ))}
          {segments.map((segment, index) => (
            <path key={index} className="analytics-line" d={segment} />
          ))}
          {rows.map((row, index) =>
            row.value === null ? null : (
              <circle
                key={index}
                className="analytics-dot"
                cx={x(index)}
                cy={y(row.value)}
                r={rows.length > 100 ? 2 : 3}
                aria-label={`${row.label}：${displayCount(row.value)}`}
              />
            ),
          )}
          {labels.map((index) => (
            <text
              key={index}
              x={x(index)}
              y={height - 10}
              textAnchor={
                rows.length === 1 ? 'middle' : index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle'
              }
            >
              {rows[index]!.shortLabel}
            </text>
          ))}
          {activeRow && activeIndex !== null && (
            <g className="analytics-chart-selection" aria-hidden="true">
              <line
                className="analytics-cursor"
                x1={x(activeIndex)}
                x2={x(activeIndex)}
                y1={top}
                y2={height - bottom}
              />
              {activeRow.value !== null && (
                <circle className="analytics-active-dot" cx={x(activeIndex)} cy={y(activeRow.value)} r={5} />
              )}
            </g>
          )}
        </svg>
      </div>
      {activeRow && activeIndex !== null && (
        <div
          id={tooltipId}
          role="tooltip"
          className="analytics-chart-tooltip"
          style={{
            left: `clamp(var(--space-4), ${(x(activeIndex) / width) * 100}%, calc(100% - var(--analytics-tooltip-width) - var(--space-4)))`,
          }}
        >
          <p className="analytics-tooltip-date">{activeRow.label}</p>
          <p className="analytics-tooltip-value">
            <span>{label}</span>
            <strong>{activeRow.value === null ? '暂无数据' : displayCount(activeRow.value)}</strong>
          </p>
        </div>
      )}
      {interactionError && (
        <p role="status" className="form-error">
          {interactionError}
        </p>
      )}
    </div>
  );
}
