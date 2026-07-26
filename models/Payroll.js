/**
 * Payroll — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  payrollToApi,
  payrollTranslateCreate,
  payrollTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  employee_id: { target: 'employeeRefId', isId: true },
  payroll_run_id: { target: 'payrollRunId', isId: true },
  record_status: { target: 'recordStatus' },
  pay_period_start: { target: 'payPeriodStart' },
  pay_period_end: { target: 'payPeriodEnd' },
};

module.exports = buildTenantModel({
  name: 'Payroll',
  collection: 'payrolls',
  delegateName: 'payroll',
  fieldMap: FIELD_MAP,
  toApi: payrollToApi,
  translateCreate: payrollTranslateCreate,
  translateUpdate: payrollTranslateUpdate,
  mutable: true,
});
