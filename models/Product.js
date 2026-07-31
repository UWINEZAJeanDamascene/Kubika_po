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

const PRISMA_TO_DB = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  name: 'name',
  sku: 'sku',
  currentStock: 'current_stock',
  sellingPrice: 'selling_price',
  costPrice: 'cost_price',
  lowStockThreshold: 'low_stock_threshold',
  averageCost: 'average_cost',
  isActive: 'is_active',
  isArchived: 'is_archived',
};

function toDbColumn(field) {
  return PRISMA_TO_DB[field] || field;
}

function buildExprWhere(expr) {
  const op = Object.keys(expr)[0];
  switch (op) {
    case '$lte': return 'p."current_stock" <= p."low_stock_threshold"';
    case '$lt': return 'p."current_stock" < p."low_stock_threshold"';
    case '$gte': return 'p."current_stock" >= p."low_stock_threshold"';
    case '$gt': return 'p."current_stock" > p."low_stock_threshold"';
    case '$eq': return 'p."current_stock" = p."low_stock_threshold"';
    default: return 'true';
  }
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

  if ($expr) {
    const explicitLimit = opts.limit != null ? Number(opts.limit) : 50;
    const explicitSkip = opts.skip != null ? Number(opts.skip) : 0;

    const sortField = translateSort(opts.sort, FIELD_MAP);
    const sortOrder = sortField && sortField[0] ? (sortField[0].order || 'asc') : 'asc';
    const rawOrderColumn = sortField && Object.keys(sortField[0])[0] ? Object.keys(sortField[0])[0] : 'createdAt';
    const orderColumn = toDbColumn(rawOrderColumn);

    const exprWhere = buildExprWhere($expr);
    const rows = await prisma.$queryRaw(
      `SELECT p.* FROM products p WHERE p."companyId" = $1 AND ${exprWhere} AND (NULLIF($2, 'null') IS NULL OR p."isArchived" = $2) AND (NULLIF($3, 'null') IS NULL OR p."isActive" = $3) AND (NULLIF($4, 'null') IS NULL OR p."categoryId" = $4) AND (NULLIF($5, 'null') IS NULL OR p."supplierId" = $5) ORDER BY p."${orderColumn}" ${sortOrder} LIMIT ${explicitLimit + explicitSkip + 500}`,
      where.companyId,
      where.isArchived,
      where.isActive,
      where.categoryId,
      where.supplierId,
    );

    const filtered = rows.filter((row) => matchesExpr(row, $expr));
    const sliced = filtered.slice(explicitSkip, explicitSkip + explicitLimit);

    return many ? sliced : (sliced[0] || null);
  }

  let rows = await prisma.product.findMany({
    where,
    orderBy: translateSort(opts.sort, FIELD_MAP),
    take: opts.limit || undefined,
    skip: opts.skip || undefined,
    include: buildProductInclude(opts.populate),
  });

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