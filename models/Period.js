/**
 * Period (legacy) — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  periodToApi,
  periodTranslateCreate,
  periodTranslateUpdate,
} = require('../utils/inventoryJournalMappers');

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  name: { target: 'name' },
  startDate: { target: 'startDate' },
  endDate: { target: 'endDate' },
  status: { target: 'status' },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

module.exports = buildTenantModel({
  name: 'Period',
  collection: 'periods',
  delegateName: 'period',
  fieldMap: FIELD_MAP,
  toApi: periodToApi,
  translateCreate: periodTranslateCreate,
  translateUpdate: periodTranslateUpdate,
  mutable: true,
});
