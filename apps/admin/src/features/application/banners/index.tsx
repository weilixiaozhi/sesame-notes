import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, request } from '../../../api/client';
import { dateTime, initialPaging, type Paging } from '../../../api/types';
import { useClampPage } from '../../../api/paging';
import { useSession } from '../../../auth/session';
import { Button, Empty, Loading, Modal, Pagination, RequestError } from '../../../components/ui';
import { bannerMetricCount, bannerSlots, bannerTargetLabel, bannerMetrics } from './model';
import type { BannerEntry, BannerSlot } from './model';
import { BannerPreview, BannerThumbnail } from './preview';
import { BannerEditor } from './editor';
import { BannerDelete } from './operations';
import './styles.css';

const queryKey = ['admin', 'banners'];
const statisticsKey = ['admin', 'banner-statistics'];
type Dialog = { mode: 'edit'; row?: BannerEntry } | { mode: 'preview' | 'delete'; row: BannerEntry };

/** 表格管理自定义轮播图并显示累计统计，空数据保留表头与分页结构。 */
export function BannersPage({ active }: { active: boolean }) {
  const { session } = useSession();
  const canWrite = session?.admin.permissions.includes('banners:write');
  const [dialog, setDialog] = useState<Dialog>();
  const [paging, setPaging] = useState<Paging>(initialPaging);
  const [position, setPosition] = useState<BannerSlot | ''>('');
  const query = useQuery({
    queryKey,
    enabled: active,
    queryFn: ({ signal }) => request(() => api.adminBanners.list(signal), 'banner-list'),
  });
  const statistics = useQuery({
    queryKey: statisticsKey,
    enabled: active,
    queryFn: ({ signal }) => request(() => api.adminBanners.statistics(signal), 'banner-statistics'),
  });
  const rows = query.data?.items.filter((entry) => !position || entry.slot === position) ?? [];
  useClampPage(query.data ? rows.length : undefined, paging, setPaging);

  return (
    <>
      <div className="page-heading">
        <h1>Banner 管理</h1>
        <div className="row-actions">
          <label className="field banner-position-filter">
            展示位置
            <select
              value={position}
              onChange={(event) => {
                setPosition(event.target.value as BannerSlot | '');
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
          {canWrite && (
            <Button variant="primary" onClick={() => setDialog({ mode: 'edit' })}>
              添加 Banner
            </Button>
          )}
        </div>
      </div>
      <section className="panel">
        {statistics.isError && <RequestError error={statistics.error} retry={() => void statistics.refetch()} />}
        <div className="table-wrap">
          <table className="banner-table">
            <thead>
              <tr>
                <th>序号</th>
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
              {query.isPending ? (
                <tr>
                  <td colSpan={10}>
                    <Loading />
                  </td>
                </tr>
              ) : query.isError ? (
                <tr>
                  <td colSpan={10}>
                    <RequestError error={query.error} retry={() => void query.refetch()} />
                  </td>
                </tr>
              ) : !rows.length ? (
                <tr>
                  <td colSpan={10}>
                    <Empty>暂无数据</Empty>
                  </td>
                </tr>
              ) : (
                rows.slice((paging.page - 1) * paging.page_size, paging.page * paging.page_size).map((entry, index) => {
                  const report = statistics.isError || statistics.isFetching ? undefined : statistics.data;
                  const metrics = bannerMetrics(entry, report);
                  return (
                    <tr key={entry.id}>
                      <td data-label="序号">{(paging.page - 1) * paging.page_size + index + 1}</td>
                      <td data-label="展示位置">{bannerSlots[entry.slot].title}</td>
                      <td data-label="图片">
                        <BannerThumbnail entry={entry} onPreview={() => setDialog({ mode: 'preview', row: entry })} />
                      </td>
                      <td data-label="跳转目标">{bannerTargetLabel(entry)}</td>
                      <td data-label="顺序">{entry.sort_order}</td>
                      <td data-label="曝光次数">{bannerMetricCount(metrics?.impressions)}</td>
                      <td data-label="点击次数">{bannerMetricCount(metrics?.clicks)}</td>
                      <td data-label="点击率">
                        {metrics?.ctr == null
                          ? '—'
                          : new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 2 }).format(
                              metrics.ctr,
                            )}
                      </td>
                      <td data-label="更新时间">{dateTime(entry.updated_at)}</td>
                      <td data-label="操作">
                        {canWrite && (
                          <div className="row-actions">
                            <Button variant="ghost" onClick={() => setDialog({ mode: 'edit', row: entry })}>
                              修改
                            </Button>
                            <Button
                              variant="ghost"
                              className="banner-delete-action"
                              onClick={() => setDialog({ mode: 'delete', row: entry })}
                            >
                              删除
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {query.data && (
          <Pagination value={paging} total={rows.length} onChange={setPaging} disabled={query.isFetching} />
        )}
      </section>
      {dialog?.mode === 'preview' && (
        <Modal title="图片预览" onClose={() => setDialog(undefined)} className="banner-image-dialog">
          <BannerPreview entry={dialog.row} />
        </Modal>
      )}
      {dialog?.mode === 'edit' && canWrite && (
        <BannerEditor
          current={dialog.row}
          initialSlot={dialog.row?.slot ?? (position || 'fitness-plan-library')}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.mode === 'delete' && canWrite && (
        <BannerDelete current={dialog.row} onClose={() => setDialog(undefined)} />
      )}
    </>
  );
}
