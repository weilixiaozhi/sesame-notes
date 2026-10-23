import { registerCategoryConflictRoutes } from './category-conflict-routes.js';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import type { ApiConfig } from '../../shared/api-config.js';
import { registerAaStatisticsRoutes } from './aa-statistics-routes.js';
import { registerCategoryActionRoutes } from './category-actions.js';
import { registerCategoryRoutes } from './category-routes.js';
import { registerExchangeRateRoutes } from './exchange-rates.js';
import { registerLedgerClearRoutes } from './ledger-clear-routes.js';
import { registerLedgerCurrencyRoutes } from './ledger-currency-routes.js';
import { registerLedgerRoutes } from './ledger-routes.js';
import { registerTransactionStatsRoutes } from './transaction-stats-routes.js';
import { registerTransactionRoutes } from './transaction-routes.js';
import { registerRecurringRoutes } from './recurring-routes.js';

export { guardCategoryWrite, normalizeCategoryDraft } from './category-conflict-service.js';

export { updateCategoryTransactionSnapshots } from './category-snapshot.js';
export { ensureDefaultCategories } from './default-categories.js';
export {
  categoryData,
  CategoryInput,
  validateParentCategory,
  assertCategoryCanDelete,
  type CategoryCreate,
} from './domain/categories.js';
export { assertCategoryNameIdentity } from './domain/category-identity.js';
export { accessibleLedgerWhere, getLedgerReadAccess, getLedgerWriteAccess } from './domain/ledger-access.js';
export {
  resolveCategory,
  resolveRecurring,
  transactionData,
  TransactionInput,
  validateCurrencySnapshot,
  type TransactionCreate,
} from './domain/transactions.js';
export { exchangeRateOverrideId } from './entity-id.js';
export { deleteLedgerRecord } from './ledger-mutations.js';
export { categoryPayload, ledgerArchiveFields, ledgerPayload, mapTransaction, mapRecurring } from './mappers.js';
export { registeredMemberId } from './member-id.js';
export { createdByMemberIdFor, resolvePayerMember, resolveSplitMembers } from './member-refs.js';
export { validateAaFields, type AaSplitInput } from './money.js';
export { ensureOwnerMember } from './owner-member.js';
export { importRecurringInitialState } from './recurring-import.js';
export {
  nextRecurringDate,
  parseOccurrenceDate,
  recurringDate,
  recurringOccurrenceId,
  recurringToday,
  validateRecurringTimeZone,
} from './recurring-schedule.js';

/** 注册账务域 REST 接口：账本、交易、分类与汇率。 */
export function registerAccountingRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  registerExchangeRateRoutes(app, prisma, config);
  registerLedgerRoutes(app, prisma, config);
  registerLedgerClearRoutes(app, prisma, config);
  registerLedgerCurrencyRoutes(app, prisma, config);
  registerCategoryRoutes(app, prisma, config);
  registerCategoryConflictRoutes(app, prisma, config);
  registerCategoryActionRoutes(app, prisma, config);
  registerTransactionRoutes(app, prisma, config);
  registerRecurringRoutes(app, prisma, config);
  registerTransactionStatsRoutes(app, prisma, config);
  registerAaStatisticsRoutes(app, prisma, config);
}

export { createTransactionMutation } from './transaction-creation.js';
export {
  deleteTransactionMutation,
  updateTransactionMutation,
  type TransactionMutationResult,
} from './transaction-mutations.js';
