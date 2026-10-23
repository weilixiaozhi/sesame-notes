import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Empty, Loading, Modal, Pagination, RequestError } from '../../components/ui';
import { initialPaging, type Paging } from '../../api/types';
import { useListQuerySubmit } from '../../lib/use-list-query-submit';
import { listFitness } from './data';
import { contentName, type FitnessRow } from './model';

/** 分页选择当前内容，停用条目可见但不能新增引用。 */
export function ReferencePicker({
  kind,
  onSelect,
  onClose,
}: {
  kind: 'exercise' | 'template';
  onSelect: (row: FitnessRow) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [paging, setPaging] = useState<Paging>(initialPaging);
  const queryKey = ['admin', 'fitness', kind, 'picker', search, paging];
  const submitQuery = useListQuerySubmit(queryKey);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => listFitness(kind, { ...paging, q: search || undefined }, signal),
  });
  return (
    <Modal title={kind === 'exercise' ? '选择动作' : '选择训练模板'} onClose={onClose} className="fitness-picker">
      <form
        className="toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const nextSearch = input.trim();
          const nextPaging = { ...paging, page: 1 };
          submitQuery(['admin', 'fitness', kind, 'picker', nextSearch, nextPaging], () => {
            setSearch(nextSearch);
            setPaging(nextPaging);
          });
        }}
      >
        <label className="field search-field">
          名称
          <input value={input} onChange={(event) => setInput(event.target.value)} />
        </label>
        <Button variant="primary" type="submit" disabled={query.isFetching}>
          查询
        </Button>
      </form>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <RequestError error={query.error} retry={() => void query.refetch()} />
      ) : query.data.items.length ? (
        <div className="fitness-picker-list">
          {query.data.items.map((row) => (
            <div key={row.id} className="fitness-picker-item">
              <span>{contentName(row.content)}</span>
              <span className="muted">{row.is_enabled ? '启用' : '停用'}</span>
              <Button
                disabled={!row.is_enabled}
                onClick={() => {
                  onSelect(row);
                  onClose();
                }}
              >
                选择
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <Empty>没有匹配的内容</Empty>
      )}
      {query.data && (
        <Pagination value={paging} total={query.data.total} onChange={setPaging} disabled={query.isFetching} />
      )}
    </Modal>
  );
}
