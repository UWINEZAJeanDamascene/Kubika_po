/**
 * Department model — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  departmentToApi,
  departmentTranslateCreate,
  departmentTranslateUpdate,
} = require('../utils/masterDataMappers');

const FIELD_MAP = {
  code: { target: 'code', transform: (v) => ({ code: typeof v === 'string' ? v.toUpperCase() : v }) },
  name: { target: 'name' },
  description: { target: 'description' },
  manager: { target: 'managerId', isId: true },
  defaultLaborAccount: { target: 'defaultLaborAccount' },
  budgetLimit: { target: 'budgetLimit' },
};

module.exports = buildTenantModel({
  name: 'Department',
  collection: 'departments',
  delegateName: 'department',
  fieldMap: FIELD_MAP,
  toApi: departmentToApi,
  translateCreate: departmentTranslateCreate,
  translateUpdate: departmentTranslateUpdate,
});
