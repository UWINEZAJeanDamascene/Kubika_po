/**
 * EmployeeAdvance — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  employeeAdvanceToApi,
  employeeAdvanceTranslateCreate,
  employeeAdvanceTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  employee: { target: 'employeeId', isId: true },
  referenceNo: { target: 'referenceNo' },
  status: { target: 'status' },
  bankAccountId: { target: 'bankAccountId', isId: true },
  journalEntryId: { target: 'journalEntryId', isId: true },
};

module.exports = buildTenantModel({
  name: 'EmployeeAdvance',
  collection: 'employeeadvances',
  delegateName: 'employeeAdvance',
  fieldMap: FIELD_MAP,
  toApi: employeeAdvanceToApi,
  translateCreate: employeeAdvanceTranslateCreate,
  translateUpdate: employeeAdvanceTranslateUpdate,
  mutable: true,
});
