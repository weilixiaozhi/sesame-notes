import { useState } from 'react';
import './analytics.css';
import { useQuery } from '@tanstack/react-query';
import { api, request } from '../../api/client';
import { initialPaging } from '../../api/types';
import { useClampPage } from '../../api/paging';
import { Button, Empty, Loading, Pagination, RequestError } from '../../components/ui';
import { BEHAVIORS } from './model';

/** 埋点清单只呈现采集定义，页面与动作由稳定命名表达，查询不依赖日期或使用数据。 */
export function TrackingManagement({ active }: { active: boolean }) {
  const [search, setSearch] = useState('');
  const [behavior, setBehavior] = useState('');
  const [platform, setPlatform] = useState('');
  const [paging, setPaging] = useState(initialPaging);
  const query = useQuery({
    queryKey: ['admin', 'analytics-catalog'],
    enabled: active,
    queryFn: ({ signal }) => request(() => api.adminAnalytics.catalog(signal), 'read-tracking-catalog'),
  });
  const keyword = search.trim().toLocaleLowerCase();
  const pageNames = new Map(
    query.data?.events.filter((entry) => entry.page_id).map((entry) => [entry.page_id, entry.name]),
  );
  const rows =
    query.data?.events.filter(
      (event) =>
        (!keyword ||
          [
            event.name,
            event.page_id,
            event.event_name,
            event.location,
            ...event.source_pages.flatMap((source) => [source.page_id, pageNames.get(source.page_id)]),
          ].some((value) => value?.toLocaleLowerCase().includes(keyword))) &&
        (!behavior || event.behavior === behavior) &&
        (!platform || event.platforms.includes(platform as 'app' | 'web')),
    ) ?? [];
  useClampPage(query.data ? rows.length : undefined, paging, setPaging);
  return (
    <div className="analytics-page">
      <div className="analytics-page-heading">
        <h1>埋点管理</h1>
        <Button onClick={() => void query.refetch()} disabled={query.isFetching}>
          刷新清单
        </Button>
      </div>
      <section className="panel">
        <div className="analytics-catalog-filters">
          <label className="field analytics-search">
            搜索事件
            <input
              value={search}
              placeholder="事件名称、英文标识或页面位置"
              onChange={(event) => {
                setSearch(event.target.value);
                setPaging(initialPaging);
              }}
            />
          </label>
          <label className="field">
            事件类型
            <select
              value={behavior}
              onChange={(event) => {
                setBehavior(event.target.value);
                setPaging(initialPaging);
              }}
            >
              <option value="">全部类型</option>
              {Object.entries(BEHAVIORS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            采集端
            <select
              value={platform}
              onChange={(event) => {
                setPlatform(event.target.value);
                setPaging(initialPaging);
              }}
            >
              <option value="">全部采集端</option>
              <option value="app">App</option>
              <option value="web">Web</option>
            </select>
          </label>
        </div>
        {query.isPending ? (
          <Loading label="正在读取埋点清单…" />
        ) : query.isError ? (
          <RequestError error={query.error} retry={() => void query.refetch()} />
        ) : (
          <>
            <div className="table-wrap">
              <table className="analytics-catalog-table">
                <thead>
                  <tr>
                    <th>事件名称</th>
                    <th>事件标识</th>
                    <th>事件类型</th>
                    <th>触发位置</th>
                    <th>采集端</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice((paging.page - 1) * paging.page_size, paging.page * paging.page_size).map((event) => (
                    <tr key={event.id}>
                      <td data-label="事件名称">{event.name}</td>
                      <td data-label="事件标识">
                        <code>{event.event_name}</code>
                      </td>
                      <td data-label="事件类型">
                        <span className={`analytics-type analytics-type-${event.behavior}`}>
                          {BEHAVIORS[event.behavior]}
                        </span>
                      </td>
                      <td data-label="触发位置">{event.location}</td>
                      <td data-label="采集端">
                        {event.platforms.map((source) => (source === 'app' ? 'App' : 'Web')).join(' / ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!rows.length && <Empty>没有匹配的埋点</Empty>}
            <Pagination value={paging} total={rows.length} onChange={setPaging} />
          </>
        )}
      </section>
    </div>
  );
}
