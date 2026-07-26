/**
 * EBMSyncState — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  ebmSyncStateToApi,
  ebmSyncStateTranslateCreate,
  ebmSyncStateTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  branchId: { target: 'branchId' },
  syncType: { target: 'syncType' },
  mode: { target: 'mode' },
  lastReqDt: { target: 'lastReqDt' },
  lastSuccessfulSyncAt: { target: 'lastSuccessfulSyncAt' },
  lastAttemptAt: { target: 'lastAttemptAt' },
};

module.exports = buildTenantModel({
  name: 'EBMSyncState',
  collection: 'ebmsyncstates',
  delegateName: 'ebmSyncState',
  fieldMap: FIELD_MAP,
  toApi: ebmSyncStateToApi,
  translateCreate: ebmSyncStateTranslateCreate,
  translateUpdate: ebmSyncStateTranslateUpdate,
  mutable: true,
});
