import { ApiError, unwrap } from '@sesame-notes/api-client';
import { createLedgerSubmitter } from '../features/accounting/entity-submit';
import { captureSessionOperation, createChangeBatch, queryClient, type SyncChange } from '../lib/session';

export type DefaultBookKind = 'accounting' | 'memos' | 'days' | 'fitness';

type Candidate = { id: string; sync_id: string; archived_at?: string | null; type?: string };
type Directory = { books: readonly Candidate[]; queryKey: readonly string[]; publish: () => void };

const defaultNames = {
  accounting: '默认账本',
  memos: '默认备忘录',
  days: '默认纪念日',
  fitness: '默认健身空间',
} satisfies Record<DefaultBookKind, string>;

/** 首次新增时才准备所属本子；同一入口的并发和重试共用已捕获的会话与提交身份。 */
export function createDefaultBookProvisioner(
  kind: DefaultBookKind,
  accountId: string,
  memoType: 'normal' | 'credentials' = 'normal',
): () => Promise<string> {
  let operation: ReturnType<typeof captureSessionOperation> | undefined;
  let batch: ReturnType<typeof createChangeBatch> | undefined;
  let submitLedger: ReturnType<typeof createLedgerSubmitter> | undefined;
  let privateChange: SyncChange | undefined;
  let primaryCurrency: string | undefined;
  let pending: Promise<string> | undefined;
  let createdId: string | undefined;

  /** 每次都读取真实云目录，完整响应在确认身份与目标后一次性发布给对应页面。 */
  async function readDirectory(): Promise<Directory> {
    operation!.assertCurrent();
    if (kind === 'accounting') {
      const data = unwrap(await operation!.client.GET('/api/v1/ledgers'));
      operation!.assertCurrent();
      return {
        books: data,
        queryKey: ['account', accountId, 'accounting', 'ledgers'],
        publish: () => queryClient.setQueryData(['account', accountId, 'accounting', 'ledgers'], data),
      };
    }
    if (kind === 'memos') {
      const data = unwrap(await operation!.client.GET('/api/v1/sync/memo-books'));
      operation!.assertCurrent();
      return {
        books: data.memo_books,
        queryKey: ['account', accountId, 'memo-books'],
        publish: () => queryClient.setQueryData(['account', accountId, 'memo-books'], data),
      };
    }
    if (kind === 'days') {
      const data = unwrap(await operation!.client.GET('/api/v1/sync/day-books'));
      operation!.assertCurrent();
      return {
        books: data.day_books,
        queryKey: ['account', accountId, 'day-books'],
        publish: () => queryClient.setQueryData(['account', accountId, 'day-books'], data),
      };
    }
    const data = unwrap(await operation!.client.GET('/api/v1/sync/fitness-spaces'));
    operation!.assertCurrent();
    return {
      books: data.fitness_spaces,
      queryKey: ['account', accountId, 'fitness', 'spaces'],
      publish: () => queryClient.setQueryData(['account', accountId, 'fitness', 'spaces'], data),
    };
  }

  /** 两类备忘录各自复用同类本；已归档账本需要显式恢复，不自动另建同名本。 */
  function available(book: Candidate): boolean {
    return kind === 'accounting' ? !book.archived_at : kind !== 'memos' || book.type === memoType;
  }

  /** 私有本的创建包固定主键、时间和变更标识，未知响应重放原包，不猜测同步身份。 */
  function createPrivateChange(): SyncChange {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const common = {
      mutation_id: crypto.randomUUID(),
      entity_id: id,
      ledger_id: null,
      action: 'upsert' as const,
      base_revision: 0,
      updated_at: now,
    };
    if (kind === 'memos') {
      return {
        ...common,
        entity_type: 'memo_book',
        day_book_id: null,
        memo_book_id: id,
        payload: {
          name: memoType === 'credentials' ? '账号密码本' : defaultNames.memos,
          type: memoType,
          created_at: now,
          updated_at: now,
        },
      };
    }
    if (kind === 'days') {
      return {
        ...common,
        entity_type: 'day_book',
        day_book_id: id,
        payload: { name: defaultNames.days, created_at: now },
      };
    }
    return {
      ...common,
      entity_type: 'fitness_space',
      day_book_id: null,
      memo_book_id: null,
      fitness_space_id: id,
      payload: { name: defaultNames.fitness, created_at: now, updated_at: now },
    };
  }

  /** 锁内先复查目录，再复用或创建；记录编辑器只接收已获得服务端绑定的父本。 */
  async function provision(): Promise<string> {
    let directory = await readDirectory();
    const candidate =
      directory.books.find((book) => book.id === (createdId ?? privateChange?.entity_id) && available(book)) ??
      directory.books.find(available);
    if (candidate) return finish(directory, candidate);
    if (kind === 'accounting' && directory.books.length > 0) {
      throw new Error('现有账本都已归档，请先恢复一个账本，再开始记录。');
    }
    if (!createdId) {
      if (kind === 'accounting') {
        submitLedger ??= createLedgerSubmitter();
        const ledger = await submitLedger({ name: defaultNames.accounting, currency: primaryCurrency ?? 'CNY' });
        operation!.assertCurrent();
        createdId = ledger.id;
      } else {
        privateChange ??= createPrivateChange();
        await batch!.push(privateChange);
        operation!.assertCurrent();
        createdId = privateChange.entity_id;
      }
    }
    directory = await readDirectory();
    const confirmed = directory.books.find((book) => book.id === createdId && available(book));
    if (!confirmed) throw new Error('本子已提交，但暂时无法确认最新状态。请稍后重试，不会重复创建。');
    return finish(directory, confirmed);
  }

  /** 同步验证会话后发布完整目录，调用者可以立即按返回标识打开记录编辑器。 */
  async function finish(directory: Directory, book: Candidate): Promise<string> {
    operation!.assertCurrent();
    if (!book.sync_id) throw new Error('本子尚未完成云端确认，请稍后重试。');
    // 旧目录查询不能在确认成功后把页面覆盖回空态；总览在下次访问时读取最新数量。
    await queryClient.cancelQueries({ queryKey: directory.queryKey, exact: true });
    operation!.assertCurrent();
    await queryClient.invalidateQueries({
      queryKey: ['account', accountId, 'overview'],
      exact: true,
      refetchType: 'none',
    });
    operation!.assertCurrent();
    directory.publish();
    return book.id;
  }

  /** 身份在点击时固定，排队等待与网络返回都不能将旧页面操作转交新账号。 */
  async function run(): Promise<string> {
    try {
      if (!operation) {
        operation = captureSessionOperation();
        batch = createChangeBatch();
      }
      operation.assertCurrent();
      if (primaryCurrency === undefined) {
        const profile = unwrap(await operation.client.GET('/api/v1/profile/me'));
        operation.assertCurrent();
        if (profile.user_id !== accountId) throw new ApiError(401, 'SESSION_CHANGED', '账号已切换，请重新打开此页面。');
        primaryCurrency =
          profile.primary_currency && /^[A-Z]{3}$/.test(profile.primary_currency) ? profile.primary_currency : 'CNY';
      }
      if (typeof navigator !== 'undefined' && navigator.locks?.request) {
        return await navigator.locks.request(
          `sesame-default-book:${accountId}:${kind}`,
          { signal: operation.signal },
          provision,
        );
      }
      return await provision();
    } catch (error) {
      console.error('准备首条记录所属本子失败', {
        kind,
        accountId,
        createdId,
        mutationId: privateChange?.mutation_id,
        error:
          error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      });
      throw error;
    }
  }

  /** 重复点击共用正在执行的任务，失败后保留创建身份供下一次显式重试。 */
  return () => {
    pending ??= run().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
