/**
 * EBMAlert — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  ebmAlertToApi,
  ebmAlertTranslateCreate,
  ebmAlertTranslateUpdate,
} = require('../utils/phase10Mappers');

const ALERT_STATUSES = Object.freeze(['open', 'acknowledged', 'reset']);

const FIELD_MAP = {
  companyId: { target: 'companyId', isId: true },
  company: { target: 'companyId', isId: true },
  queueId: { target: 'queueId', isId: true },
  documentType: { target: 'documentType' },
  documentId: { target: 'documentId', isId: true },
  status: { target: 'status' },
  acknowledged: { target: 'acknowledged' },
};

const EBMAlert = buildTenantModel({
  name: 'EBMAlert',
  collection: 'ebmalerts',
  delegateName: 'ebmAlert',
  fieldMap: FIELD_MAP,
  toApi: ebmAlertToApi,
  translateCreate: ebmAlertTranslateCreate,
  translateUpdate: ebmAlertTranslateUpdate,
  tenantField: 'companyId',
  mutable: true,
});

module.exports = EBMAlert;
module.exports.ALERT_STATUSES = ALERT_STATUSES;
