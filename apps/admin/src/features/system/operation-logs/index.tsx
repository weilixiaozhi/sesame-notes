import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Empty, Loading, Modal, Pagination, RequestError } from '../../../components/ui';
import { api, request } from '../../../api/client';
import { useClampPage } from '../../../api/paging';
import { useListQuerySubmit } from '../../../lib/use-list-query-submit';
import { dateTime, initialPaging } from '../../../api/types';
import type { Audit, Paging } from '../../../api/types';

const emptyFilters = { action: '', actor: '', target: '', from: '', to: '' };

/** 时间输入明确按上海时区转换，空日期不向接口发送无效值。 */
function isoDate(value: string): string | undefined {
  if (!value) return undefined;
  try {
    return new Date(`${value}+08:00`).toISOString();
  } catch {
    return undefined;
  }
}

/** 操作日志只呈现服务端解析的业务名称，不透出 UUID、内部操作码或请求编号。 */
export function AuditPage({ active }: { active: boolean }) {
  const [paging, setPaging] = useState<Paging>(initialPaging);
  const [filters, setFilters] = useState(emptyFilters);
  const [draft, setDraft] = useState(emptyFilters);
  const [selected, setSelected] = useState<Audit | null>(null);
  const [invalid, setInvalid] = useState('');
  const actions = useQuery({
    queryKey: ['admin', 'audit-actions'],
    enabled: active,
    queryFn: ({ signal }) => request(() => api.adminAudit.actions(signal), 'audit-actions'),
  });
  const queryKey = ['admin', 'audit', filters, paging];
  const submitQuery = useListQuerySubmit(queryKey, active);
  const query = useQuery({
    queryKey,
    enabled: active,
    queryFn: ({ signal }) =>
      request(
        () =>
          api.adminAudit.list(
            {
              ...paging,
              action: filters.action || undefined,
              actor_search: filters.actor || undefined,
              target_search: filters.target || undefined,
              created_from: isoDate(filters.from),
              created_to: isoDate(filters.to),
            },
            signal,
          ),
        'audit-logs',
      ),
  });
  useClampPage(query.data?.total, paging, setPaging);
  return (
    <>
      <h1 className="sr-only">操作日志</h1>
      <section className="panel">
        <form
          className="toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.from && draft.to && draft.from > draft.to) {
              setInvalid('结束时间不能早于开始时间。');
              return;
            }
            setInvalid('');
            const nextFilters = { ...draft, actor: draft.actor.trim(), target: draft.target.trim() };
            const nextPaging = { ...paging, page: 1 };
            submitQuery(['admin', 'audit', nextFilters, nextPaging], () => {
              setFilters(nextFilters);
              setPaging(nextPaging);
            });
          }}
        >
          <div className="filter-grid">
            <label className="field">
              操作类型
              <select
                value={draft.action}
                disabled={!actions.data}
                onChange={(event) => setDraft({ ...draft, action: event.target.value })}
              >
                <option value="">全部类型</option>
                {actions.data?.map((action) => (
                  <option key={action.value} value={action.value}>
                    {action.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              操作者
              <input
                value={draft.actor}
                onChange={(event) => setDraft({ ...draft, actor: event.target.value })}
                placeholder="登录账号"
                autoComplete="off"
              />
            </label>
            <label className="field">
              操作对象
              <input
                value={draft.target}
                onChange={(event) => setDraft({ ...draft, target: event.target.value })}
                placeholder="芝麻号、昵称或用户组"
                autoComplete="off"
              />
            </label>
            <label className="field">
              开始时间（上海）
              <input
                type="datetime-local"
                value={draft.from}
                onChange={(event) => setDraft({ ...draft, from: event.target.value })}
              />
            </label>
            <label className="field">
              结束时间（上海）
              <input
                type="datetime-local"
                value={draft.to}
                onChange={(event) => setDraft({ ...draft, to: event.target.value })}
              />
            </label>
          </div>
          {actions.isError && <RequestError error={actions.error} retry={() => void actions.refetch()} />}
          {invalid && (
            <div role="alert" className="form-error">
              {invalid}
            </div>
          )}
          <Button type="submit" variant="primary" disabled={query.isFetching}>
            查询
          </Button>
          <Button
            onClick={() => {
              setDraft(emptyFilters);
              setFilters(emptyFilters);
              setPaging(initialPaging);
              setInvalid('');
            }}
          >
            重置
          </Button>
        </form>
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <RequestError error={query.error} retry={() => void query.refetch()} />
        ) : query.data.items.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>发生时间</th>
                  <th>操作</th>
                  <th>操作者</th>
                  <th>操作对象</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((record) => (
                  <tr key={record.id}>
                    <td data-label="发生时间">{dateTime(record.created_at)}</td>
                    <td data-label="操作">{record.action_label || '未识别的操作'}</td>
                    <td data-label="操作者">{record.actor_display || '未提供'}</td>
                    <td data-label="操作对象">{record.target_display || '未提供'}</td>
                    <td data-label="详情">
                      <Button variant="ghost" onClick={() => setSelected(record)}>
                        查看
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>没有匹配的操作记录</Empty>
        )}
        {query.data && <Pagination value={paging} total={query.data.total} onChange={setPaging} />}
      </section>
      {selected && (
        <Modal title="操作记录" onClose={() => setSelected(null)}>
          <dl className="detail-grid">
            {[
              ['操作', selected.action_label || '未识别的操作'],
              ['发生时间', dateTime(selected.created_at)],
              ['操作者', selected.actor_display || '未提供'],
              ['操作对象', selected.target_display || '未提供'],
              ['来源 IP', selected.ip || '未提供'],
              ['操作摘要', selected.summary || '未提供'],
              ['操作原因', selected.reason || '未提供'],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </Modal>
      )}
    </>
  );
}
