/**
 * AccountingPeriod — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  accountingPeriodToApi,
  accountingPeriodTranslateCreate,
  accountingPeriodTranslateUpdate,
} = require('../utils/inventoryJournalMappers');

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  company_id: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  name: { target: 'name' },
  period_type: { target: 'periodType' },
  start_date: { target: 'startDate' },
  end_date: { target: 'endDate' },
  fiscal_year: { target: 'fiscalYear' },
  status: { target: 'status' },
  closed_by: { target: 'closedById', isId: true },
  is_year_end: { target: 'isYearEnd' },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

module.exports = buildTenantModel({
  name: 'AccountingPeriod',
  collection: 'accountingperiods',
  delegateName: 'accountingPeriod',
  fieldMap: FIELD_MAP,
  toApi: accountingPeriodToApi,
  translateCreate: accountingPeriodTranslateCreate,
  translateUpdate: accountingPeriodTranslateUpdate,
  mutable: true,
});
