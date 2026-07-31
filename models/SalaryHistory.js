/**
 * SalaryHistory — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const { prisma } = require('../lib/prisma');
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

const SalaryHistory = buildTenantModel({
  name: 'SalaryHistory',
  collection: 'salaryhistories',
  delegateName: 'salaryHistory',
  fieldMap: FIELD_MAP,
  toApi: salaryHistoryToApi,
  translateCreate: salaryHistoryTranslateCreate,
  translateUpdate: salaryHistoryTranslateUpdate,
  mutable: true,
});

SalaryHistory.getEffectiveSalary = async function(employeeId, asOfDate, companyId) {
  const rows = await prisma.salaryHistory.findMany({
    where: {
      companyId,
      employeeId,
      effectiveDate: { lte: asOfDate },
      OR: [
        { endDate: null },
        { endDate: { gte: asOfDate } },
      ],
    },
    orderBy: { effectiveDate: 'desc' },
    take: 1,
  });
  if (!rows.length) return null;
  const row = rows[0];
  return {
    id: row.id,
    companyId: row.companyId,
    employeeId: row.employeeId,
    basicSalary: Number(row.basicSalary),
    transportAllowance: Number(row.transportAllowance),
    housingAllowance: Number(row.housingAllowance),
    otherAllowances: Number(row.otherAllowances),
    currency: row.currency,
    effectiveDate: row.effectiveDate,
    endDate: row.endDate,
    reason: row.reason,
    changedById: row.changedById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

module.exports = SalaryHistory;
