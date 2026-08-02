/**
 * Legacy SerialNumber model - PostgreSQL-backed compatibility facade.
 *
 * Older /stock/advanced routes use `serialNumber` and statuses like `available`.
 * The canonical migrated table is `stock_serial_numbers`, whose API uses
 * `serialNo` and statuses such as `in_stock` / `dispatched`. This shim keeps the
 * old controller surface alive without sending reads or writes to MongoDB.
 */

const { prisma } = require('../lib/prisma');
const { makeCompatModel } = require('../utils/prismaCompat');
const { toIdString } = require('../utils/objectId');
const { decimalToNumber, mapTimestamps } = require('../utils/decimalHelpers');
const { tenantCreateBase } = require('../utils/inventoryJournalMappers');

function legacyStatusToStock(status) {
  switch (status) {
    case 'available':
      return 'in_stock';
    case 'sold':
    case 'in_use':
    case 'under_warranty':
      return 'dispatched';
    case 'damaged':
    case 'retired':
      return 'scrapped';
    case 'returned':
      return 'returned';
    default:
      return status || 'in_stock';
  }
}

function stockStatusToLegacy(status) {
  switch (status) {
    case 'in_stock':
    case 'reserved':
      return 'available';
    case 'dispatched':
      return 'sold';
    case 'scrapped':
      return 'damaged';
    case 'returned':
      return 'returned';
    default:
      return status || 'available';
  }
}

function relationRef(row, relationName, fallbackId) {
  const value = row && row[relationName];
  if (value && typeof value === 'object') {
    return { _id: value.id, ...value };
  }
  return fallbackId || null;
}

function serialNumberToApi(row) {
  if (!row) return null;
  const legacyStatus = stockStatusToLegacy(row.status);
  return {
    _id: row.id,
    company: row.companyId,
    product: relationRef(row, 'product', row.productId),
    warehouse: relationRef(row, 'warehouse', row.warehouseId),
    serialNumber: row.serialNo,
    serialNo: row.serialNo,
    status: legacyStatus,
    purchaseDate: row.createdAt,
    purchasePrice: decimalToNumber(row.unitCost, 0),
    supplier: null,
    invoice: row.dispatchedVia || null,
    stockMovement: null,
    saleDate: row.status === 'dispatched' ? row.updatedAt : null,
    salePrice: null,
    client: null,
    warrantyStartDate: null,
    warrantyEndDate: null,
    warrantyDetails: null,
    manufacturingDate: null,
    notes: row.notes ?? null,
    locationHistory: [],
    createdBy: null,
    isWarrantyActive: false,
    ...mapTimestamps(row),
  };
}

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  product: { target: 'productId', isId: true },
  warehouse: { target: 'warehouseId', isId: true },
  serialNumber: {
    target: 'serialNo',
    transform: (value) => ({ serialNo: typeof value === 'string' ? value.toUpperCase() : value }),
  },
  serialNo: {
    target: 'serialNo',
    transform: (value) => ({ serialNo: typeof value === 'string' ? value.toUpperCase() : value }),
  },
  status: {
    target: 'status',
    transform: (value) => ({ status: legacyStatusToStock(value) }),
  },
  stockMovement: { target: 'grnId', isId: true },
  invoice: { target: 'dispatchedVia', isId: true },
  notes: { target: 'notes' },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

function buildInclude(populate = []) {
  if (!populate || !populate.length) return undefined;
  const include = {};
  for (const entry of populate) {
    const path = typeof entry === 'object' ? entry.path : entry;
    if (path === 'product') include.product = { select: { id: true, name: true, sku: true, unit: true, trackingType: true } };
    if (path === 'warehouse') include.warehouse = { select: { id: true, name: true, code: true } };
    if (path === 'batch') include.batch = { select: { id: true, batchNo: true, expiryDate: true } };
  }
  return Object.keys(include).length ? include : undefined;
}

async function serialNumberTranslateCreate(data = {}) {
  const base = tenantCreateBase(data);
  return {
    ...base,
    serialNo: String(data.serialNumber || data.serialNo || '').toUpperCase(),
    productId: toIdString(data.product),
    warehouseId: toIdString(data.warehouse),
    grnId: data.stockMovement ? toIdString(data.stockMovement) : null,
    unitCost: data.purchasePrice ?? data.unitCost ?? 0,
    status: legacyStatusToStock(data.status || 'available'),
    dispatchedVia: data.invoice ? toIdString(data.invoice) : null,
    returnedVia: null,
    notes: data.notes ?? null,
  };
}

function serialNumberTranslateUpdate(update = {}) {
  const data = { ...(update.$set || update) };
  const out = {};
  if (data.serialNumber !== undefined || data.serialNo !== undefined) {
    out.serialNo = String(data.serialNumber || data.serialNo || '').toUpperCase();
  }
  if (data.product !== undefined) out.productId = toIdString(data.product);
  if (data.warehouse !== undefined) out.warehouseId = toIdString(data.warehouse);
  if (data.status !== undefined) out.status = legacyStatusToStock(data.status);
  if (data.purchasePrice !== undefined || data.unitCost !== undefined) out.unitCost = data.purchasePrice ?? data.unitCost;
  if (data.invoice !== undefined) out.dispatchedVia = data.invoice ? toIdString(data.invoice) : null;
  if (data.notes !== undefined) out.notes = data.notes;
  return out;
}

const SerialNumber = makeCompatModel({
  delegate: () => prisma.stockSerialNumber,
  fieldMap: FIELD_MAP,
  toApi: serialNumberToApi,
  translateCreate: serialNumberTranslateCreate,
  translateUpdate: serialNumberTranslateUpdate,
  include: buildInclude,
  mutable: true,
  tenantField: 'companyId',
});

SerialNumber.findAvailable = function findAvailable(productId, companyId) {
  return SerialNumber.find({ product: productId, company: companyId, status: 'available' });
};

SerialNumber.findBySerial = function findBySerial(serialNumber, companyId) {
  return SerialNumber.findOne({ serialNumber: String(serialNumber || '').toUpperCase(), company: companyId });
};

module.exports = SerialNumber;
