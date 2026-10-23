import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { unwrap } from '@sesame-notes/api-client';
import { api, pushChange, type SyncChange } from '../../lib/session';
import { Button, Dialog, ErrorState, Field, LoadingState } from '../../components/ui';
import type { FitnessSpace } from './fitness-types';

/** 删除前固定完整快照游标，服务端拒绝删除确认后被其他设备修改的空间。 */
export function DeleteSpaceDialog({
  space,
  userId,
  onClose,
  onDeleted,
}: {
  space: FitnessSpace;
  userId: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [confirmation, setConfirmation] = useState({ name: '', cursor: '' });
  const writing = useRef(false);
  const cache = useQueryClient();
  const attempt = useRef<Extract<SyncChange, { entity_type: 'fitness_space'; action: 'delete' }> | null>(null);
  const snapshot = useQuery({
    queryKey: ['account', userId, 'fitness', space.id, 'delete-preview'],
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/sync/fitness-spaces/full', {
          params: { query: { fitness_space_id: space.id, sync_id: space.sync_id } },
          signal,
        }),
      ),
    enabled: () => !writing.current,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const deletion = useMutation({
    mutationFn: async () => {
      const captured = snapshot.data;
      if (
        !captured ||
        confirmation.name !== captured.fitness_space.name ||
        confirmation.cursor !== captured.server_cursor
      )
        throw new Error('请先核对并输入完整空间名称。');
      if (
        !attempt.current ||
        attempt.current.payload.expected_full_cursor !== captured.server_cursor ||
        attempt.current.base_revision !== captured.fitness_space.revision
      )
        attempt.current = {
          mutation_id: crypto.randomUUID(),
          entity_type: 'fitness_space',
          entity_id: space.id,
          ledger_id: null,
          day_book_id: null,
          memo_book_id: null,
          fitness_space_id: space.id,
          sync_id: captured.fitness_space.sync_id,
          base_revision: captured.fitness_space.revision,
          action: 'delete',
          updated_at: new Date().toISOString(),
          payload: { expected_full_cursor: captured.server_cursor },
        };
      writing.current = true;
      await cache.cancelQueries({ queryKey: ['account', userId, 'fitness', space.id, 'delete-preview'] });
      try {
        await pushChange(attempt.current);
      } catch (error) {
        writing.current = false;
        // 保留已确认快照供同 mutation 重试；响应丢失时不要先查询可能已删除的空间。
        throw error;
      }
    },
    onSuccess: onDeleted,
  });
  const counts = snapshot.data
    ? ([
        ['训练', snapshot.data.fitness_workouts.filter((item) => !item.deleted_at).length],
        ['模板', snapshot.data.fitness_templates.filter((item) => !item.deleted_at).length],
        ['计划', snapshot.data.fitness_plans.filter((item) => !item.deleted_at).length],
      ] as const)
    : [];
  /** 发生并发修改时重新读取并再次输入名称，不能沿用旧确认。 */
  function reload() {
    if (deletion.isPending) return;
    setConfirmation({ name: '', cursor: '' });
    attempt.current = null;
    deletion.reset();
    void snapshot.refetch();
  }
  return (
    <Dialog
      open
      title="删除健身空间"
      description="删除会同步到其他设备，空间内的云端训练、模板、计划与偏好将一并移除。"
      onClose={() => {
        if (!deletion.isPending) onClose();
      }}
    >
      <div className="fitness-form">
        {snapshot.isPending ? (
          <LoadingState label="正在核对完整云端空间…" />
        ) : snapshot.isError ? (
          <ErrorState error={snapshot.error} retry={reload} />
        ) : (
          <>
            <p>
              确认删除 <strong>{snapshot.data.fitness_space.name}</strong>？
            </p>
            <p className="fitness-info">
              {counts.map(([label, count]) => `${label} ${count} 项`).join(' · ')}。如需保留，请先导出数据。
            </p>
            {confirmation.name && confirmation.cursor !== snapshot.data.server_cursor && (
              <p className="fitness-info">云端数据已变化，请重新核对数量并重新输入名称。</p>
            )}
            <Field label="输入完整空间名称确认">
              <input
                autoComplete="off"
                value={confirmation.name}
                disabled={deletion.isPending || snapshot.isFetching}
                onChange={(event) =>
                  setConfirmation({ name: event.target.value, cursor: snapshot.data?.server_cursor ?? '' })
                }
              />
            </Field>
            {snapshot.isFetching && <LoadingState label="正在重新核对完整云端空间…" />}
          </>
        )}
        {deletion.isError && (
          <>
            <ErrorState error={deletion.error} />
            <Button variant="secondary" onClick={reload}>
              重新核对空间
            </Button>
          </>
        )}
        <div className="fitness-dialog-actions">
          <Button
            variant="danger"
            disabled={
              deletion.isPending ||
              snapshot.isFetching ||
              snapshot.isError ||
              !snapshot.data ||
              confirmation.name !== snapshot.data.fitness_space.name ||
              confirmation.cursor !== snapshot.data.server_cursor
            }
            onClick={() => deletion.mutate()}
          >
            {deletion.isPending ? '正在删除…' : '确认删除空间'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
