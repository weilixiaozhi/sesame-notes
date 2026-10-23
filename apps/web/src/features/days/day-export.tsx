import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useCsvDownload } from '../accounting/transfer/csv-download';
import { unwrap } from '@sesame-notes/api-client';
import { api, useSession } from '../../lib/session';
import { Button, Dialog, ErrorState, LoadingState } from '../../components/ui';
import { buildDefinition, type DayBook, type DayDate, type DayEvent } from './day-dates';
import { downloadText, exportFileName } from '../../lib/transfer/download';

const headers = [
  'name',
  'category',
  'date',
  'calendar',
  'is_leap_month',
  'repeat_type',
  'statistic_type',
  'start_date',
  'start_calendar',
  'start_is_leap_month',
  'end_date',
  'end_calendar',
  'end_is_leap_month',
  'countdown_mode',
  'interval_days',
  'created_at',
  'updated_at',
];

/** 日子 CSV 沿用移动端字段名，原始农历年月日不替换为公历投影。 */
export function dayExportCsv(book: DayBook, entries: DayEvent[]): string {
  const originalDate = (date: DayDate | null) =>
    date
      ? `${date.original_year}-${String(date.original_month).padStart(2, '0')}-${String(date.original_day).padStart(2, '0')}`
      : '';
  const cell = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const rows = entries
    .filter((entry) => entry.deleted_at === null)
    .map((entry) => {
      if (entry.day_book_id !== book.id) throw new Error('导出日子与当前本子不一致');
      const value = buildDefinition(entry);
      return [
        value.name,
        value.category,
        originalDate(value.event),
        value.event?.calendar_type,
        value.event?.is_leap_month,
        value.repeat_type,
        value.statistic_type,
        originalDate(value.start),
        value.start?.calendar_type,
        value.start?.is_leap_month,
        originalDate(value.end),
        value.end?.calendar_type,
        value.end?.is_leap_month,
        value.countdown_mode,
        value.interval_days,
        value.created_at,
        entry.updated_at,
      ]
        .map(cell)
        .join(',');
    });
  const text = `\uFEFF${[headers.join(','), ...rows].join('\n')}`;
  if (new TextEncoder().encode(text).byteLength > 64 * 1024 * 1024) throw new Error('导出内容超过 64 MB，请先分本整理');
  return text;
}

/** 导出按完整快照读取，加载或失败期间不会下载残缺的分页内容。 */
export function DayExport({ book }: { book: DayBook }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        <Download size={16} />
        导出
      </Button>
      {open && <DayExportDialog book={book} onClose={() => setOpen(false)} />}
    </>
  );
}

/** 文件生成仅由用户点击触发，不修改云端记录。 */
function DayExportDialog({ book, onClose }: { book: DayBook; onClose: () => void }) {
  const { session } = useSession();
  const csvDownload = useCsvDownload();
  const [error, setError] = useState<unknown>(null);
  const data = useQuery({
    queryKey: ['account', session!.user.user_id, 'day-export', book.id],
    gcTime: 0,
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/sync/day-books/full', {
          signal,
          params: { query: { day_book_id: book.id, sync_id: book.sync_id } },
        }),
      ),
  });
  /** 保留所有原始日期信息，生成失败时留在弹窗供用户重试。 */
  function download() {
    if (!data.data) return;
    try {
      const text = csvDownload.prepare(dayExportCsv(data.data.day_book, data.data.day_events));
      if (text === null) return;
      downloadText(text, `${exportFileName(book.name)}.csv`, 'text/csv;charset=utf-8');
      setError(null);
    } catch {
      setError(new Error('无法导出当前日子本，请重新读取并检查日期是否完整。'));
    }
  }
  return (
    <Dialog open title="导出日子本" onClose={onClose} description="导出日期、重复规则和阶段信息。">
      {data.isPending ? (
        <LoadingState label="正在准备整本内容…" />
      ) : data.isError ? (
        <ErrorState
          error={data.error}
          retry={() => {
            void data.refetch();
          }}
        />
      ) : (
        <div className="stack">
          <p>
            将导出“{book.name}”的 {data.data.day_events.length} 个日子。
          </p>
          {error !== null && <ErrorState error={error} />}
          {csvDownload.controls}
          <Button onClick={download}>
            <Download size={16} />
            下载 CSV
          </Button>
        </div>
      )}
    </Dialog>
  );
}
