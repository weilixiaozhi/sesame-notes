import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, request } from '../api/client';
import { Button, RequestError } from './ui';
import { automaticGroupLabel, groupChoiceLabel, showExplicitGroup } from './group-options';
import type { GroupChoice } from './group-options';
import { useListQuerySubmit } from '../lib/use-list-query-submit';

/** 单组选项从服务端分页查询并保留已选项，列表筛选模式支持按名称查找。 */
export function GroupSelect({
  value,
  onChange,
  selected,
  mode = 'edit',
  defaultGroup,
}: {
  value: string;
  onChange: (id: string) => void;
  selected?: GroupChoice;
  mode?: 'create' | 'edit' | 'filter';
  defaultGroup?: GroupChoice;
}) {
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [remembered, setRemembered] = useState(selected);
  const [knownDefault, setKnownDefault] = useState(defaultGroup);
  const activeSearch = mode === 'filter' ? search : '';
  const queryKey = ['admin', 'groups', 'selector', activeSearch, page];
  const submitQuery = useListQuerySubmit(queryKey, mode === 'filter');
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      request(
        () => api.adminGroups.list({ q: activeSearch || undefined, page, page_size: 20 }, signal),
        'select-group',
      ),
  });
  const options = query.data?.items || [];
  const explicitOptions = options.filter((group) => showExplicitGroup(group, mode === 'create'));
  const current =
    options.find((group) => group.id === value) ||
    (remembered?.id === value ? remembered : selected?.id === value ? selected : undefined);
  const discoveredDefault = options.find((group) => group.is_default) || defaultGroup;
  useEffect(() => {
    if (discoveredDefault) setKnownDefault(discoveredDefault);
  }, [discoveredDefault]);
  useEffect(() => {
    if (mode === 'create' && value && current?.is_default) onChange('');
  }, [mode, value, current?.is_default, onChange]);
  /** 按钮和回车使用同一目标查询，不提交外层账号筛选表单。 */
  function searchGroups() {
    const nextSearch = draft.trim();
    submitQuery(['admin', 'groups', 'selector', nextSearch, 1], () => {
      setSearch(nextSearch);
      setPage(1);
    });
  }
  return (
    <div className="group-select">
      {mode === 'filter' && (
        <div className="inline-fields">
          <input
            aria-label="搜索用户组"
            placeholder="按名称搜索用户组"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                searchGroups();
              }
            }}
          />
          <Button onClick={searchGroups} disabled={query.isFetching}>
            查找
          </Button>
        </div>
      )}
      {query.isError ? (
        <RequestError error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          <select
            aria-label="所属用户组"
            value={value}
            required={mode === 'edit'}
            onChange={(event) => {
              const group = options.find((item) => item.id === event.target.value);
              if (group) setRemembered(group);
              onChange(event.target.value);
            }}
            disabled={query.isPending}
          >
            <option value="" disabled={mode === 'edit'}>
              {mode === 'filter'
                ? '全部用户组'
                : mode === 'create'
                  ? automaticGroupLabel(knownDefault)
                  : '请选择用户组'}
            </option>
            {current &&
              showExplicitGroup(current, mode === 'create') &&
              !explicitOptions.some((group) => group.id === current.id) && (
                <option value={current.id}>{groupChoiceLabel(current)}</option>
              )}
            {explicitOptions.map((group) => (
              <option key={group.id} value={group.id}>
                {groupChoiceLabel(group)}
                {group.is_enabled ? '' : '（已禁用）'}
              </option>
            ))}
          </select>
          {query.data && query.data.total > 20 && (
            <div className="selector-pages">
              <Button variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                上一页
              </Button>
              <span>共 {query.data.total} 组</span>
              <Button variant="ghost" disabled={page * 20 >= query.data.total} onClick={() => setPage(page + 1)}>
                下一页
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
