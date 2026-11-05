import { ApiError } from '@sesame-notes/api-client';
import { captureAdminOperationScope } from './operation-scope';

/** 为一个新增编辑过程保留创建身份，未知结果先恢复原请求，再修改同一实体。 */
export function createAdminCreation<Input, Entity>(operations: {
  create: (body: Input, idempotencyKey: string) => Promise<Entity>;
  update: (saved: Entity, body: Input, previous: Input) => Promise<Entity>;
}): (body: Input) => Promise<Entity> {
  const assertCurrent = captureAdminOperationScope();
  type Attempt = { key: string; body: Input; fingerprint: string; uncertain: boolean };
  let attempt: Attempt | undefined;
  let confirmed: { entity: Entity; body: Input; fingerprint: string } | undefined;
  let pending: Promise<Entity> | undefined;

  /** 明确拒绝仅能释放首次尚未提交的意图，键冲突不能通过更换键规避。 */
  function rejectedBeforeCommit(error: unknown): boolean {
    return (
      error instanceof ApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408 &&
      !error.code.startsWith('HTTP_') &&
      error.code !== 'ADMIN_CREATION_KEY_REUSED'
    );
  }

  /** 冻结创建载荷后只用原键恢复；后续草稿始终更新已确认的同一实体。 */
  async function save(body: Input): Promise<Entity> {
    assertCurrent();
    const next = structuredClone(body);
    const fingerprint = JSON.stringify(next);
    if (!confirmed) {
      attempt ??= { key: crypto.randomUUID(), body: next, fingerprint, uncertain: false };
      const frozen = attempt;
      let entity: Entity;
      try {
        assertCurrent();
        entity = await operations.create(structuredClone(frozen.body), frozen.key);
      } catch (error) {
        assertCurrent();
        // 未知提交后即使重试遇到撤权或校验失败，原意图仍可能已提交，必须保留其身份。
        if (!frozen.uncertain && rejectedBeforeCommit(error)) attempt = undefined;
        else frozen.uncertain = true;
        throw error;
      }
      assertCurrent();
      confirmed = { entity, body: frozen.body, fingerprint: frozen.fingerprint };
    }
    if (confirmed.fingerprint === fingerprint) return confirmed.entity;
    // 只有更新响应成功才推进版本，更新失败仍保留原实体，绝不退回新增分支。
    try {
      assertCurrent();
      const entity = await operations.update(confirmed.entity, next, confirmed.body);
      assertCurrent();
      confirmed = { entity, body: next, fingerprint };
      return entity;
    } catch (error) {
      assertCurrent();
      throw error;
    }
  }

  /** 同一个编辑器的连续提交共用在途任务，调用方仍负责展示忙碌和错误反馈。 */
  return (body) => {
    pending ??= save(body).finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
