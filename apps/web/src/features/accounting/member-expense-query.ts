import { useQuery } from '@tanstack/react-query';
import { unwrap, type components, type paths } from '@sesame-notes/api-client';
import { api } from '../../lib/session';

/** 成员页与 AA 总付共用全时间付款人口径，历史无效分摊仍属于实际付款。 */
export function useMemberExpenseStats(ledger: components['schemas']['Ledger'], accountId: string) {
  return useQuery({
    queryKey: ['account', accountId, 'accounting', ledger.id, 'member-expenses', ledger.currency, 'payer', 'all'],
    queryFn: async ({ signal }) => {
      const query = { scope: 'all', dimension: 'payer' } satisfies NonNullable<
        paths['/api/v1/ledgers/{ledger_id}/member-stats']['get']['parameters']['query']
      >;
      return unwrap(
        await api.GET('/api/v1/ledgers/{ledger_id}/member-stats', {
          signal,
          params: { path: { ledger_id: ledger.id }, query },
        }),
      );
    },
  });
}
