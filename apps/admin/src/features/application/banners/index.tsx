import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, request } from '../../../api/client';
import { dateTime, initialPaging, type Paging } from '../../../api/types';
import { useClampPage } from '../../../api/paging';
import { useSession } from '../../../auth/session';
import { Button, Empty, Loading, Modal, Pagination, RequestError } from '../../../components/ui';
import { presetRange, validateRange } from '../../analytics/date-range';
import { bannerMetricCount, bannerSlots, bannerTargetLabel, currentBannerMetrics } from './model';
import type { BannerEntry, BannerSlot } from './model';
import { BannerPreview, BannerThumbnail } from './preview';
import { BannerEditor } from './editor';
import { BannerDelete, BannerReset } from './operations';
import './styles.css';

const queryKey = ['admin', 'banners'];
const statisticsKey = ['admin', 'banner-statistics'];
type BannerRange = { start_date: string; end_date: string };
type Dialog =
  | { mode: 'edit'; row?: BannerEntry; slot: BannerSlot }
  | { mode: 'preview' | 'delete'; row: BannerEntry }
  | { mode: 'reset'; slot: BannerSlot };

/** 入口轮播图采用查询区、数据表格与独立编辑弹窗，统计只关联当前显示配置。 */
export function BannersPage({ active }: { active: boolean }) {
  const { session } = useSession();
  const canWrite = session?.admin.permissions.includes('banners:write');
  const [dialog, setDialog] = useState<Dialog>();
  const [paging, setPaging] = useState<Paging>(initialPaging);
  const [range, setRange] = useState<BannerRange>(() => presetRange('week'));
  const [draftRange, setDraftRange] = useState(range);
  const [preset, setPreset] = useState('week');
  const [slot, setSlot] = useState('');
  const [rangeError, setRangeError] = useState('');
  const query = useQuery({
    queryKey,
    enabled: active,
    queryFn: ({ signal }) => request(() => api.adminBanners.list(signal), 'banner-list'),
  });
  const statistics = useQuery({
    queryKey: [...statisticsKey, range],
    enabled: active,
    queryFn: ({ signal }) =>
      request(
        () =>
          api.adminBanners.statistics(
            {
              start_date: range.start_date,
              end_date: range.end_date,
            },
            signal,
          ),
        'banner-statistics',
      ),
  });
  const rows = query.data?.items.filter((entry) => !slot || entry.slot === slot) ?? [];
  useClampPage(query.data ? rows.length : undefined, paging, setPaging);
  const initialSlot = (slot || 'fitness-plan-library') as BannerSlot;

  /** 日期统一按北京时间验证，重复查询相同范围也刷新配置与统计。 */
  function search(): void {
    try {
      const value = validateRange({ ...draftRange, platform: 'app' });
      setRange({ start_date: value.start_date, end_date: value.end_date });
      setRangeError('');
      setPaging(initialPaging);
      void query.refetch();
      if (range.start_date === value.start_date && range.end_date === value.end_date) void statistics.refetch();
    } catch (error) {
      setRangeError(error instanceof Error ? error.message : '请选择有效的统计日期。');
    }
  }

  return (
    <>
      <div className="page-heading">
        <h1>Banner 管理</h1>
        {canWrite && (
          <div className="row-actions">
            <Button
              disabled={!query.data?.items.some((entry) => entry.source === 'remote')}
              onClick={() => setDialog({ mode: 'reset', slot: initialSlot })}
            >
              恢复默认
            </Button>
            <Button variant="primary" onClick={() => setDialog({ mode: 'edit', slot: initialSlot })}>
              添加图片
            </Button>
          </div>
        )}
      </div>
      <section className="panel">
        <form
          className="toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            search();
          }}
        >
          <label className="field">
            展示位置
            <select
              value={slot}
              onChange={(event) => {
                setSlot(event.target.value);
                setPaging(initialPaging);
              }}
            >
              <option value="">全部位置</option>
              {Object.entries(bannerSlots).map(([value, item]) => (
                <option key={value} value={value}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            统计范围
            <select
              value={preset}
              onChange={(event) => {
                const value = event.target.value;
                setPreset(value);
                if (value !== 'custom') setDraftRange(presetRange(value as 'today' | 'week' | 'month'));
              }}
            >
              <option value="today">今天</option>
              <option value="week">近 7 天</option>
              <option value="month">近 30 天</option>
              <option value="custom">自定义</option>
            </select>
          </label>
          {preset === 'custom' && (
            <>
              <label className="field">
                开始日期
                <input
                  type="date"
                  required
                  value={draftRange.start_date}
                  max={presetRange('today').end_date}
                  onChange={(event) => setDraftRange({ ...draftRange, start_date: event.target.value })}
                />
              </label>
              <label className="field">
                结束日期
                <input
                  type="date"
                  required
                  value={draftRange.end_date}
                  max={presetRange('today').end_date}
                  onChange={(event) => setDraftRange({ ...draftRange, end_date: event.target.value })}
                />
              </label>
            </>
          )}
          <Button type="submit" variant="primary" disabled={query.isFetching || statistics.isFetching}>
            查询
          </Button>
          <Button
            onClick={() => {
              const value = presetRange('week');
              setSlot('');
              setPreset('week');
              setDraftRange(value);
              setRange(value);
              setRangeError('');
              setPaging(initialPaging);
            }}
          >
            重置
          </Button>
        </form>
        {rangeError && (
          <p className="form-error" role="alert">
            {rangeError}
          </p>
        )}
        <p className="muted banner-statistics-note">
          {range.start_date} 至 {range.end_date}（北京时间） · 已登录 App 用户 · 每张图当前配置的统计
        </p>
        {statistics.isError && <RequestError error={statistics.error} retry={() => void statistics.refetch()} />}
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <RequestError error={query.error} retry={() => void query.refetch()} />
        ) : !rows.length ? (
          <Empty>没有匹配的入口</Empty>
        ) : (
          <div className="table-wrap">
            <table className="banner-table">
              <thead>
                <tr>
                  <th>展示位置</th>
                  <th>图片</th>
                  <th>跳转目标</th>
                  <th>顺序</th>
                  <th>曝光次数</th>
                  <th>点击次数</th>
                  <th>点击率</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice((paging.page - 1) * paging.page_size, paging.page * paging.page_size).map((entry) => {
                  const report = statistics.isError || statistics.isFetching ? undefined : statistics.data;
                  const metrics = currentBannerMetrics(entry, report);
                  return (
                    <tr key={entry.id}>
                      <td data-label="展示位置">{bannerSlots[entry.slot].title}</td>
                      <td data-label="图片">
                        <BannerThumbnail entry={entry} onPreview={() => setDialog({ mode: 'preview', row: entry })} />
                        <small className="banner-source">{entry.source === 'builtin' ? '内置默认' : '自定义'}</small>
                      </td>
                      <td data-label="跳转目标">{bannerTargetLabel(entry)}</td>
                      <td data-label="顺序">{entry.source === 'builtin' ? '—' : entry.sort_order}</td>
                      <td data-label="曝光次数">{bannerMetricCount(metrics?.impressions, report)}</td>
                      <td data-label="点击次数">{bannerMetricCount(metrics?.clicks, report)}</td>
                      <td data-label="点击率">
                        {metrics?.ctr == null || !report || (!report.coverage.complete && !metrics.clicks)
                          ? '—'
                          : new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 2 }).format(
                              metrics.ctr,
                            )}
                      </td>
                      <td data-label="更新时间">
                        {dateTime(entry.updated_at)}
                        {entry.updated_by && <small className="banner-source">{entry.updated_by}</small>}
                      </td>
                      <td data-label="操作">
                        <div className="row-actions">
                          <Button variant="ghost" onClick={() => setDialog({ mode: 'preview', row: entry })}>
                            预览
                          </Button>
                          {canWrite && (
                            <>
                              <Button
                                variant="ghost"
                                onClick={() =>
                                  setDialog({
                                    mode: 'edit',
                                    row: entry.source === 'remote' ? entry : undefined,
                                    slot: entry.slot,
                                  })
                                }
                              >
                                修改
                              </Button>
                              {entry.source === 'remote' && (
                                <Button variant="ghost" onClick={() => setDialog({ mode: 'delete', row: entry })}>
                                  删除
                                </Button>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {query.data && (
          <Pagination value={paging} total={rows.length} onChange={setPaging} disabled={query.isFetching} />
        )}
        {statistics.data && !statistics.data.coverage.complete && (
          <p className="muted banner-statistics-note">
            曝光与点击从 {dateTime(statistics.data.coverage.collection_started_at)}{' '}
            开始采集；此前数据不可用，「—」不代表零次。
          </p>
        )}
      </section>
      {dialog?.mode === 'preview' && (
        <Modal
          title={bannerSlots[dialog.row.slot].title}
          onClose={() => setDialog(undefined)}
          className="banner-editor"
        >
          <div className="form-stack">
            <BannerPreview entry={dialog.row} />
            <p>点击进入：{bannerTargetLabel(dialog.row)}</p>
          </div>
        </Modal>
      )}
      {dialog?.mode === 'edit' && canWrite && (
        <BannerEditor current={dialog.row} initialSlot={dialog.slot} onClose={() => setDialog(undefined)} />
      )}
      {dialog?.mode === 'delete' && canWrite && (
        <BannerDelete current={dialog.row} onClose={() => setDialog(undefined)} />
      )}
      {dialog?.mode === 'reset' && canWrite && (
        <BannerReset initialSlot={dialog.slot} entries={query.data?.items ?? []} onClose={() => setDialog(undefined)} />
      )}
    </>
  );
}
