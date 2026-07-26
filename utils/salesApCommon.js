/**
 * Shared helpers for Phase 5+6 sales/AP Prisma shims.
 */

const { buildTenantModel } = require('./masterDataCommon');

const STANDARD_DOC_FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  createdBy: { target: 'createdById', isId: true },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

function buildLineInclude(lineKey = 'lines', productSelect = true) {
  return (populate = []) => {
    const inc = {};
    const wantsLines = !populate.some((p) => {
      const path = typeof p === 'object' ? p.path : p;
      return path === `-${lineKey}` || path === '-lines' || path === '-items';
    });
    if (wantsLines) {
      const wantsFullProduct = populate.some((p) => {
        const path = typeof p === 'object' ? p.path : p;
        return path === `${lineKey}.product` || path === 'lines.product' || path === 'items.product';
      });
      let productInclude;
      if (!productSelect) {
        productInclude = undefined;
      } else if (wantsFullProduct) {
        // Controllers that populate lines.product typically need stock fields
        productInclude = { product: true };
      } else {
        productInclude = { product: { select: { id: true, name: true, sku: true, unit: true } } };
      }
      inc[lineKey] = {
        orderBy: { lineOrder: 'asc' },
        include: productInclude,
      };
    }
    for (const p of populate) {
      const path = typeof p === 'object' ? p.path : p;
      if (path === 'client') inc.client = true;
      if (path === 'supplier') inc.supplier = true;
      if (path === 'warehouse') inc.warehouse = true;
      if (path === 'quotation') inc.quotation = { select: { id: true, referenceNo: true } };
      if (path === 'invoice') inc.invoice = { select: { id: true, referenceNo: true, status: true, currencyCode: true, totalAmount: true } };
      if (path === 'salesOrder') {
        // Only include when the model has a salesOrder relation (scalar FKs use deferred populate)
        inc.salesOrder = { select: { id: true, referenceNo: true } };
      }
      if (path === 'deliveryNote') inc.deliveryNote = { select: { id: true, referenceNo: true } };
      if (path === 'purchaseOrder') inc.purchaseOrder = { select: { id: true, referenceNo: true } };
      if (path === 'assignedTo') {
        // deferred via DOC_POPULATE_REFS when no Prisma relation exists
      }
      if (path === 'revenueJournalEntry' || path === 'cogsJournalEntry') {
        // JournalEntry shim loaded on populate via postgresRefPlugin
      }
    }
    return Object.keys(inc).length ? inc : undefined;
  };
}

function buildDocumentModel(config) {
  return buildTenantModel({
    tenantField: 'companyId',
    mutable: true,
    fieldMap: { ...STANDARD_DOC_FIELD_MAP, ...config.fieldMap },
    include: config.include || buildLineInclude(),
    ...config,
  });
}

module.exports = {
  STANDARD_DOC_FIELD_MAP,
  buildLineInclude,
  buildDocumentModel,
};
