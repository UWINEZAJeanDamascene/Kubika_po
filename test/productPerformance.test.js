const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { paginationMeta } = require('../utils/pagination');
const Product = require('../models/Product');
const { prisma } = require('../lib/prisma');
const tenantContext = require('../lib/tenantContext');

const MAX_LIST_MS = 3000;
const MAX_DETAIL_MS = 3000;

function withCompany(companyId, fn) {
  return tenantContext.run({ companyId }, fn);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildProductSearchOr(term) {
  const trimmed = String(term).trim();
  if (!trimmed) return null;
  const escaped = escapeRegex(trimmed);
  const or = [
    { sku: { $regex: `^${escaped}`, $options: 'i' } },
    { name: { $regex: `^${escaped}`, $options: 'i' } },
    { barcode: trimmed },
  ];
  if (trimmed.length >= 4) {
    or.push({ description: { $regex: escaped, $options: 'i' } });
  }
  return or;
}

describe('product list/detail performance', () => {
  let sampleCompanyId;
  let sampleProductId;

  beforeAll(async () => {
    const product = await prisma.product.findFirst({
      select: { id: true, companyId: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!product) {
      console.warn('[productPerformance] No products in database — skipping integration benchmarks');
      return;
    }
    sampleCompanyId = product.companyId;
    sampleProductId = product.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('paginationMeta exposes currentPage and totalPages aliases', () => {
    const meta = paginationMeta(2, 10, 45);
    expect(meta.page).toBe(2);
    expect(meta.pages).toBe(5);
    expect(meta.currentPage).toBe(2);
    expect(meta.totalPages).toBe(5);
  });

  test('buildProductSearchOr prefers prefix clauses', () => {
    const or = buildProductSearchOr('abc');
    expect(or).toHaveLength(3);
    expect(or[0].sku.$regex).toBe('^abc');
    expect(or[1].name.$regex).toBe('^abc');
    expect(or[2].barcode).toBe('abc');
  });

  test('product list query completes within budget', async () => {
    if (!sampleCompanyId) return;

    const query = { company: sampleCompanyId, isArchived: false, isActive: true };
    const started = Date.now();
    const products = await withCompany(sampleCompanyId, () => Product.find(query)
      .select('_id company name sku barcode category unit supplier currentStock reservedQuantity isActive lowStockThreshold averageCost sellingPrice costPrice costingMethod isArchived trackingType trackBatch trackSerialNumbers defaultWarehouse createdAt updatedAt')
      .sort({ createdAt: -1 })
      .skip(0)
      .limit(10)
      .populate('category', 'name')
      .populate('supplier', 'name code')
      .lean());
    const elapsed = Date.now() - started;

    expect(Array.isArray(products)).toBe(true);
    expect(elapsed).toBeLessThan(MAX_LIST_MS);
  });

  test('product list search query completes within budget', async () => {
    if (!sampleCompanyId) return;

    const query = {
      company: sampleCompanyId,
      isArchived: false,
      isActive: true,
      $or: buildProductSearchOr('a'),
    };
    const started = Date.now();
    const products = await withCompany(sampleCompanyId, () => Product.find(query)
      .select('_id company name sku barcode category unit supplier currentStock reservedQuantity isActive lowStockThreshold averageCost sellingPrice costPrice costingMethod isArchived trackingType trackBatch trackSerialNumbers defaultWarehouse createdAt updatedAt')
      .sort({ createdAt: -1 })
      .skip(0)
      .limit(10)
      .populate('category', 'name')
      .populate('supplier', 'name code')
      .lean());
    const elapsed = Date.now() - started;

    expect(Array.isArray(products)).toBe(true);
    expect(elapsed).toBeLessThan(MAX_LIST_MS);
  });

  test('product detail query completes within budget', async () => {
    if (!sampleCompanyId || !sampleProductId) return;

    const started = Date.now();
    const product = await withCompany(sampleCompanyId, () => Product.findOne({ _id: sampleProductId, company: sampleCompanyId })
      .select('_id company name sku barcode barcodeType description category unit supplier preferredSupplier currentStock reservedQuantity isActive isStockable lowStockThreshold averageCost sellingPrice costPrice costingMethod inventoryAccount cogsAccount revenueAccount isArchived brand location trackingType trackBatch trackSerialNumbers reorderPoint reorderQuantity defaultWarehouse taxCode taxRate ebm createdBy createdAt updatedAt')
      .populate('category', 'name')
      .populate('supplier', 'name code')
      .populate('preferredSupplier', 'name code')
      .populate('defaultWarehouse', 'name code')
      .populate('createdBy', 'name email')
      .lean());
    const elapsed = Date.now() - started;

    expect(product).toBeTruthy();
    expect(elapsed).toBeLessThan(MAX_DETAIL_MS);
  });
});
