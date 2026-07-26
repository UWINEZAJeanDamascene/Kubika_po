/**
 * DeferredRevenue model — PostgreSQL (Prisma) backed.
 *
 * Mutable so deferredRevenueService can keep using `item.save()` while it walks
 * the recognition schedule.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  deferredRevenueToApi,
  deferredRevenueTranslateCreate,
  deferredRevenueTranslateUpdate,
} = require('../utils/deferralMappers');

const FIELD_MAP = {
  referenceNo: { target: 'referenceNo' },
  customer: { target: 'customer' },
  description: { target: 'description' },
  status: { target: 'status' },
  frequency: { target: 'frequency' },
  paymentMethod: { target: 'paymentMethod' },
  revenueAccountCode: { target: 'revenueAccountCode' },
  bankAccountId: { target: 'bankAccountId', isId: true },
  journalEntryId: { target: 'journalEntryId', isId: true },
  startDate: { target: 'startDate' },
  endDate: { target: 'endDate' },
  totalAmount: { target: 'totalAmount' },
  remainingBalance: { target: 'remainingBalance' },
  totalRecognized: { target: 'totalRecognized' },
};

module.exports = buildTenantModel({
  name: 'DeferredRevenue',
  collection: 'deferredrevenues',
  delegateName: 'deferredRevenue',
  fieldMap: FIELD_MAP,
  toApi: deferredRevenueToApi,
  translateCreate: deferredRevenueTranslateCreate,
  translateUpdate: deferredRevenueTranslateUpdate,
  mutable: true,
});
