import { UUID_PATTERN } from '../../shared/contracts/scalars.js';
import { uuidV5 } from '../../shared/uuid.js';

const EXCHANGE_RATE_NAMESPACE = 'cefe9382-b932-5eb7-827d-18944198fbb9';

/** 生成用户级汇率覆盖的确定性 UUIDv5，使离线端对同一币种对独立写入时仍会收敛到同一实体。 */
export function exchangeRateOverrideId(ownerId: string, baseCurrency: string, quoteCurrency: string): string {
  try {
    if (!new RegExp(UUID_PATTERN).test(ownerId)) throw new Error('INVALID_EXCHANGE_RATE_OWNER');
    const base = normalizeCurrency(baseCurrency);
    const quote = normalizeCurrency(quoteCurrency);
    return uuidV5(EXCHANGE_RATE_NAMESPACE, `${ownerId}:${base}:${quote}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('INVALID_')) throw error;
    throw new Error('EXCHANGE_RATE_ID_GENERATION_FAILED', { cause: error });
  }
}

/** 将币种规范为 ISO 4217 风格的大写三字母代码，避免大小写差异生成多个逻辑实体。 */
function normalizeCurrency(currency: string): string {
  try {
    const normalized = currency.toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalized)) throw new Error('INVALID_EXCHANGE_RATE_CURRENCY');
    return normalized;
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_EXCHANGE_RATE_CURRENCY') throw error;
    throw new Error('INVALID_EXCHANGE_RATE_CURRENCY', { cause: error });
  }
}
