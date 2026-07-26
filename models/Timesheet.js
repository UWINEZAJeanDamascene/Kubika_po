/**
 * Timesheet — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  timesheetToApi,
  timesheetTranslateCreate,
  timesheetTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  employee: { target: 'employeeId', isId: true },
  status: { target: 'status' },
  approvedBy: { target: 'approvedById', isId: true },
};

module.exports = buildTenantModel({
  name: 'Timesheet',
  collection: 'timesheets',
  delegateName: 'timesheet',
  fieldMap: FIELD_MAP,
  toApi: timesheetToApi,
  translateCreate: timesheetTranslateCreate,
  translateUpdate: timesheetTranslateUpdate,
  mutable: true,
});
