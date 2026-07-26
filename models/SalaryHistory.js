/**
 * SalaryHistory — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  salaryHistoryToApi,
  salaryHistoryTranslateCreate,
  salaryHistoryTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  employee: { target: 'employeeId', isId: true },
  effectiveDate: { target: 'effectiveDate' },
  endDate: { target: 'endDate' },
  changedBy: { target: 'changedById', isId: true },
};

module.exports = buildTenantModel({
  name: 'SalaryHistory',
  collection: 'salaryhistories',
  delegateName: 'salaryHistory',
  fieldMap: FIELD_MAP,
  toApi: salaryHistoryToApi,
  translateCreate: salaryHistoryTranslateCreate,
  translateUpdate: salaryHistoryTranslateUpdate,
  mutable: true,
});
