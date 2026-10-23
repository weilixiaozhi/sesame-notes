import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { unwrap } from '@sesame-notes/api-client';
import { api, pushChange, useSession } from '../../lib/session';
import { useDraftClose } from '../../components/use-draft-close';
import { Button, Dialog, ErrorState, Field, LoadingState } from '../../components/ui';
import type { DayBook } from './day-dates';

/** 仅在用户确认名称后提交整本删除；快照过期时要求重新核对。 */
export function DeleteDayBookDialog({
  book,
  onClose,
  onDeleted,
}: {
  book: DayBook;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const writing = useRef(false);
  const [confirmationName, setConfirmationName] = useState('');
  const snapshot = useQuery({
    queryKey: ['account', session!.user.user_id, 'day-delete-snapshot', book.id],
    enabled: () => !writing.current,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/sync/day-books/full', {
          signal,
          params: { query: { day_book_id: book.id, sync_id: book.sync_id } },
        }),
      ),
  });
  const attempt = useRef({ cursor: '', mutationId: crypto.randomUUID(), updatedAt: new Date().toISOString() });
  const remove = useMutation({
    mutationFn: async () => {
      const data = snapshot.data;
      if (!data || confirmationName !== data.day_book.name) throw new Error('请填写本子完整名称以确认删除');
      if (attempt.current.cursor !== data.server_cursor)
        attempt.current = {
          cursor: data.server_cursor,
          mutationId: crypto.randomUUID(),
          updatedAt: new Date().toISOString(),
        };
      writing.current = true;
      await queryClient.cancelQueries({ queryKey: ['account', session!.user.user_id, 'day-delete-snapshot', book.id] });
      try {
        await pushChange({
          mutation_id: attempt.current.mutationId,
          entity_type: 'day_book',
          entity_id: book.id,
          ledger_id: null,
          day_book_id: book.id,
          sync_id: data.day_book.sync_id,
          base_revision: data.day_book.revision,
          updated_at: attempt.current.updatedAt,
          action: 'delete',
          payload: { expected_full_cursor: data.server_cursor },
        });
      } catch (error) {
        writing.current = false;
        throw error;
      }
    },
  });
  const { close, confirmation, finish } = useDraftClose(false, remove.isPending, onClose);
  return (
    <Dialog
      open
      title="删除整个日子本？"
      onClose={close}
      description="本内所有日子都会从云端删除，并同步到其他设备。请仔细确认。"
    >
      {snapshot.isPending ? (
        <LoadingState label="正在核对整本最新内容…" />
      ) : snapshot.isError ? (
        <ErrorState
          error={snapshot.error}
          retry={() => {
            void snapshot.refetch();
          }}
        />
      ) : (
        <div className="stack">
          <p>
            “{snapshot.data.day_book.name}”中共有 <strong>{snapshot.data.day_events.length}</strong> 个日子。
          </p>
          <Field label="输入本子完整名称以确认">
            <input
              value={confirmationName}
              autoComplete="off"
              disabled={remove.isPending}
              onChange={(event) => setConfirmationName(event.target.value)}
            />
          </Field>
          {remove.isError && (
            <ErrorState
              error={remove.error}
              retry={() => {
                setConfirmationName('');
                remove.reset();
                void snapshot.refetch();
              }}
            />
          )}
          <div className="dialog-actions">
            <Button
              variant="danger"
              disabled={remove.isPending || snapshot.isFetching || confirmationName !== snapshot.data.day_book.name}
              onClick={() => remove.mutate(undefined, { onSuccess: () => finish(onDeleted) })}
            >
              {remove.isPending ? '删除中…' : '删除整个本子'}
            </Button>
          </div>
        </div>
      )}
      {confirmation}
    </Dialog>
  );
}
