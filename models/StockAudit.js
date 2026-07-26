/**
 * StockAudit — PostgreSQL (Prisma) backed.
 * Embedded items[] loaded from stock_audit_lines.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  stockAuditToApi,
  stockAuditTranslateCreate,
  stockAuditTranslateUpdate,
} = require('../utils/inventoryJournalMappers');

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  referenceNo: { target: 'referenceNo' },
  warehouse: { target: 'warehouseId', isId: true },
  status: { target: 'status' },
  auditDate: { target: 'auditDate' },
  category: { target: 'categoryId', isId: true },
  journalEntry: { target: 'journalEntryId', isId: true },
  createdBy: { target: 'createdById', isId: true },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

function buildInclude() {
  return { lines: { orderBy: { createdAt: 'asc' } } };
}

module.exports = buildTenantModel({
  name: 'StockAudit',
  collection: 'stockaudits',
  delegateName: 'stockAudit',
  fieldMap: FIELD_MAP,
  toApi: stockAuditToApi,
  translateCreate: stockAuditTranslateCreate,
  translateUpdate: stockAuditTranslateUpdate,
  include: buildInclude,
  mutable: true,
});
