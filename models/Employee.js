/**
 * Employee — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  employeeToApi,
  employeeTranslateCreate,
  employeeTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  employeeId: { target: 'employeeId' },
  status: { target: 'status' },
  firstName: { target: 'firstName' },
  lastName: { target: 'lastName' },
  departmentRef: { target: 'departmentRefId', isId: true },
  managerId: { target: 'managerId', isId: true },
  laborType: { target: 'laborType' },
};

module.exports = buildTenantModel({
  name: 'Employee',
  collection: 'employees',
  delegateName: 'employee',
  fieldMap: FIELD_MAP,
  toApi: employeeToApi,
  translateCreate: employeeTranslateCreate,
  translateUpdate: employeeTranslateUpdate,
  mutable: true,
});
