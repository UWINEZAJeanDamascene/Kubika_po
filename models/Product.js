/**
 * Product model — PostgreSQL (Prisma) backed.
 * Supports mutable docs (.save()) and customFind for $expr low-stock queries.
 */

const { prisma } = require('../lib/prisma');
const { translateFilter, translateSort, IMPOSSIBLE } = require('../utils/prismaCompat');
const { getCompanyId } = require('../utils/prismaTenant');
const { decimalToNumber } = require('../utils/decimalHelpers');
const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  productToApi,
  productTranslateCreate,
  productTranslateUpdate,
} = require('../utils/masterDataMappers');
const { sanitizeProductHistory } = require('../utils/productHistoryHelpers');

function productDocToUpdate(doc) {
  const plain = doc.toObject ? doc.toObject() : { ...doc };
  plain.history = sanitizeProductHistory(plain.history);
  return productTranslateUpdate({ $set: plain });
}

const FIELD_MAP = {
  name: { target: 'name' },
  sku: { target: 'sku', transform: (v) => ({ sku: typeof v === 'string' ? v.toUpperCase() : v }) },
  barcode: { target: 'barcode' },
  barcodeType: { target: 'barcodeType' },
  description: { target: 'description' },
  category: { target: 'categoryId', isId: true },
  unit: { target: 'unit' },
  supplier: { target: 'supplierId', isId: true },
  currentStock: { target: 'currentStock' },
  reservedQuantity: { target: 'reservedQuantity' },
  isActive: { target: 'isActive' },
  isStockable: { target: 'isStockable' },
  lowStockThreshold: { target: 'lowStockThreshold' },
  averageCost: { target: 'averageCost' },
  sellingPrice: { target: 'sellingPrice' },
  costPrice: { target: 'costPrice' },
  lastSupplyDate: { target: 'lastSupplyDate' },
  lastSaleDate: { target: 'lastSaleDate' },
  costingMethod: { target: 'costingMethod' },
  inventoryAccount: { target: 'inventoryAccount' },
  cogsAccount: { target: 'cogsAccount' },
  revenueAccount: { target: 'revenueAccount' },
  isArchived: { target: 'isArchived' },
  weight: { target: 'weight' },
  brand: { target: 'brand' },
  location: { target: 'location' },
  trackingType: { target: 'trackingType' },
  trackBatch: { target: 'trackBatch' },
  trackSerialNumbers: { target: 'trackSerialNumbers' },
  reorderPoint: { target: 'reorderPoint' },
  reorderQuantity: { target: 'reorderQuantity' },
  defaultWarehouse: { target: 'defaultWarehouseId', isId: true },
  preferredSupplier: { target: 'preferredSupplierId', isId: true },
  taxCode: { target: 'taxCode' },
  taxRate: { target: 'taxRate' },
  ebm: { target: 'ebm' },
  history: { target: 'history' },
  customFields: { target: 'customFields' },
};

function applyTenant(where, opts = {}) {
  if (where === IMPOSSIBLE) return where;
  if (opts.skipTenant) return where;
  if (where && where.companyId !== undefined) return where;
  const companyId = opts.companyId || getCompanyId();
  if (!companyId) return where;
  return { ...where, companyId: String(companyId) };
}

function matchesExpr(row, expr) {
  if (!expr) return true;
  const op = Object.keys(expr)[0];
  const cs = decimalToNumber(row.currentStock, 0);
  const th = decimalToNumber(row.lowStockThreshold, 0);
  switch (op) {
    case '$lte': return cs <= th;
    case '$lt': return cs < th;
    case '$gte': return cs >= th;
    case '$gt': return cs > th;
    case '$eq': return cs === th;
    default: return true;
  }
}

function buildProductInclude(populate = []) {
  if (!populate || !populate.length) return undefined;
  const inc = {};
  for (const p of populate) {
    const path = typeof p === 'object' ? p.path : p;
    if (path === 'category') inc.category = true;
    if (path === 'supplier') inc.supplier = true;
    if (path === 'preferredSupplier') inc.preferredSupplier = true;
    if (path === 'defaultWarehouse') inc.defaultWarehouse = true;
  }
  return Object.keys(inc).length ? inc : undefined;
}

async function productCustomFind(filter, opts, { many = false } = {}) {
  const { $expr, $or, $text, ...rest } = filter;
  const where = applyTenant(translateFilter(rest, FIELD_MAP), opts);
  if (where === IMPOSSIBLE) return many ? [] : null;

  if ($or && Array.isArray($or)) {
    const clauses = [];
    for (const clause of $or) {
      const translated = translateFilter(clause, FIELD_MAP);
      if (translated !== IMPOSSIBLE) clauses.push(translated);
    }
    if (!clauses.length) return many ? [] : null;
    where.OR = clauses;
  }

  if ($text && $text.$search) {
    const term = String($text.$search).trim();
    if (term) {
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { sku: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
        { barcode: { contains: term, mode: 'insensitive' } },
      ];
    }
  }

  let rows = await prisma.product.findMany({
    where,
    orderBy: translateSort(opts.sort, FIELD_MAP),
    take: $expr ? undefined : (opts.limit || undefined),
    skip: $expr ? undefined : (opts.skip || undefined),
    include: buildProductInclude(opts.populate),
  });

  if ($expr) {
    rows = rows.filter((row) => matchesExpr(row, $expr));
    if (opts.skip) rows = rows.slice(Number(opts.skip));
    if (opts.limit) rows = rows.slice(0, Number(opts.limit));
  }

  return many ? rows : (rows[0] || null);
}

const Product = buildTenantModel({
  name: 'Product',
  collection: 'products',
  delegateName: 'product',
  fieldMap: FIELD_MAP,
  toApi: productToApi,
  translateCreate: productTranslateCreate,
  translateUpdate: productTranslateUpdate,
  docToUpdate: productDocToUpdate,
  include: buildProductInclude,
  mutable: true,
  customFind: productCustomFind,
});

module.exports = Product;
