import { ApiError, unwrap, type components, type paths } from '@sesame-notes/api-client';
import { captureSessionOperation } from '../../lib/session';

type LedgerInput = paths['/api/v1/ledgers']['post']['requestBody']['content']['application/json'];
type CategoryInput =
  paths['/api/v1/ledgers/{ledger_id}/categories']['post']['requestBody']['content']['application/json'];

/** 新建账本固定实体 ID，未知提交结果先读取确认，后续修正始终写入同一个账本。 */
export function createLedgerSubmitter() {
  const api = captureSessionOperation().client;
  const id = crypto.randomUUID();
  return createConfirmedSubmitter<LedgerInput, components['schemas']['Ledger']>({
    create: async (body) => unwrap(await api.POST('/api/v1/ledgers', { body: { ...body, id } })),
    read: async () => {
      try {
        return unwrap(await api.GET('/api/v1/ledgers/{ledger_id}', { params: { path: { ledger_id: id } } }));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    matches: (saved, body) =>
      saved.name === body.name &&
      saved.currency === (body.currency ?? 'CNY') &&
      saved.month_start_day === (body.month_start_day ?? 1) &&
      saved.aa_enabled === (body.aa_enabled ?? false),
    patch: async (saved, body) => {
      // 新建后更换币种需要重算流程，不通过普通更新接口静默改变已保存账本的货币含义。
      if (saved.currency !== (body.currency ?? 'CNY'))
        throw new ApiError(
          400,
          'LEDGER_CURRENCY_CHANGE_REQUIRED',
          '这个账本已创建成功。请刷新后在账本的“更换本位币”中调整币种。',
        );
      return unwrap(
        await api.PATCH('/api/v1/ledgers/{ledger_id}', {
          params: { path: { ledger_id: saved.id } },
          body: { name: body.name, month_start_day: body.month_start_day, aa_enabled: body.aa_enabled },
        }),
      );
    },
  });
}

/** 分类创建按客户端 ID 恢复提交结果；读取核对不匹配时拒绝覆盖其他修改。 */
export function createCategorySubmitter(ledgerId: string) {
  const api = captureSessionOperation().client;
  const id = crypto.randomUUID();
  return createConfirmedSubmitter<CategoryInput, components['schemas']['Category']>({
    create: async (body) =>
      unwrap(
        await api.POST('/api/v1/ledgers/{ledger_id}/categories', {
          params: { path: { ledger_id: ledgerId } },
          body: { ...body, id },
        }),
      ),
    read: async () => {
      const all = unwrap(
        await api.GET('/api/v1/ledgers/{ledger_id}/categories', {
          params: { path: { ledger_id: ledgerId } },
        }),
      );
      return all.find((category) => category.id === id) ?? null;
    },
    matches: (saved, body) =>
      saved.name === body.name &&
      saved.kind === body.kind &&
      saved.level === body.level &&
      saved.parent_id === (body.parent_id ?? null) &&
      saved.sort_order === (body.sort_order ?? 0) &&
      saved.icon === (body.icon ?? null),
    patch: async (saved, body) => {
      const { id: _id, ...patch } = body;
      return unwrap(
        await api.PATCH('/api/v1/ledgers/{ledger_id}/categories/{category_id}', {
          params: { path: { ledger_id: ledgerId, category_id: saved.id } },
          body: patch,
        }),
      );
    },
  });
}

/** 只有原请求字段与权威记录一致才恢复成功，不能把唯一约束冲突直接视为成功。 */
function createConfirmedSubmitter<Input, Entity>(operations: {
  create: (body: Input) => Promise<Entity>;
  read: () => Promise<Entity | null>;
  matches: (saved: Entity, body: Input) => boolean;
  patch: (saved: Entity, body: Input) => Promise<Entity>;
}) {
  type Attempt = { body: Input; fingerprint: string };
  type PendingPatch = Attempt & { kind: 'patch'; base: Entity; previous: Attempt; outcome: 'unknown' | 'rejected' };
  let uncertain: (Attempt & { kind: 'create' }) | PendingPatch | null = null;
  let confirmed: Entity | null = null;
  let confirmedBody: Input | null = null;
  let confirmedFingerprint = '';

  /** 只有服务端响应或权威读取确认后才更新成功内容和指纹。 */
  function confirm(saved: Entity, attempt: Attempt): void {
    confirmed = saved;
    confirmedBody = attempt.body;
    confirmedFingerprint = attempt.fingerprint;
    uncertain = null;
  }

  /** 明确的请求拒绝不代表未知写入；超时和非业务响应仍需读取核对。 */
  function definitelyRejected(error: unknown): boolean {
    return error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408;
  }

  /** 先登记冻结修改，响应丢失后任何草稿都必须先解决该修改的真实结果。 */
  async function writePatch(pending: PendingPatch): Promise<Entity> {
    uncertain = pending;
    try {
      const saved = await operations.patch(pending.base, pending.body);
      confirm(saved, pending);
      return saved;
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) uncertain = null;
      else if (definitelyRejected(error)) uncertain = { ...pending, outcome: 'rejected' };
      throw error;
    }
  }

  /** 读取恢复只确认自己此前提交的内容，遇到不一致要求用户核对最新记录。 */
  async function recover() {
    const pending = uncertain;
    if (!pending) return;
    const saved = await operations.read();
    if (!saved) {
      if (pending.kind === 'patch') throw new Error('上次保存的记录已不存在，请刷新后核对，当前草稿仍保留。');
      return;
    }
    if (operations.matches(saved, pending.body)) {
      confirm(saved, pending);
      return;
    }
    if (pending.kind === 'patch' && operations.matches(saved, pending.previous.body)) {
      // 明确拒绝后需重新确认原内容仍在；未知结果则先完成原修改，再处理后续草稿。
      if (pending.outcome === 'rejected') confirm(saved, pending.previous);
      else await writePatch({ ...pending, base: saved });
      return;
    }
    throw new Error(
      pending.kind === 'create'
        ? '上次创建的内容已发生变化，请刷新后核对已有记录，避免覆盖其他设备的修改。'
        : '上次修改的内容已发生变化，请刷新后核对已有记录，避免覆盖其他设备的修改。',
    );
  }
  return async (body: Input): Promise<Entity> => {
    const attempt = { body: structuredClone(body), fingerprint: JSON.stringify(body) };
    if (uncertain) await recover();
    if (!confirmed) {
      try {
        confirm(await operations.create(attempt.body), attempt);
      } catch (error) {
        // 创建冲突也可能来自同一固定身份此前已提交的请求，需要读取后确认。
        if (!definitelyRejected(error) || (error instanceof ApiError && error.status === 409)) {
          uncertain = { kind: 'create', ...attempt };
          await recover();
        }
        if (!confirmed) throw error;
      }
    }
    if (confirmedFingerprint === attempt.fingerprint) return confirmed!;
    return writePatch({
      kind: 'patch',
      ...attempt,
      base: confirmed!,
      previous: { body: confirmedBody!, fingerprint: confirmedFingerprint },
      outcome: 'unknown',
    });
  };
}
