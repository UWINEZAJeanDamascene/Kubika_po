/**
 * ETL: Sync Phase 2 master-data collections from MongoDB → PostgreSQL.
 *
 * Usage:
 *   node scripts/etl/sync-phase2-mongo-to-postgres.js
 *   node scripts/etl/sync-phase2-mongo-to-postgres.js --dry-run
 *
 * Requires: MONGODB_URI and DATABASE_URL
 */
require('dotenv').config();

const mongoose = require('mongoose');
const { prisma, connectPrisma, disconnectPrisma } = require('../../lib/prisma');

const DRY_RUN = process.argv.includes('--dry-run');

function rawModel(name, collection) {
  const modelName = `EtlPhase2${name}`;
  if (mongoose.models[modelName]) return mongoose.models[modelName];
  return mongoose.model(modelName, new mongoose.Schema({}, { strict: false, collection }));
}

function oid(value) {
  if (value == null) return null;
  return String(value);
}

function dec(value, fallback = 0) {
  if (value == null) return fallback;
  if (typeof value === 'object' && value.$numberDecimal) return value.$numberDecimal;
  if (typeof value === 'object' && value.toString) return value.toString();
  return value;
}

async function companyExists(companyId) {
  if (!companyId) return false;
  const row = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
  return Boolean(row);
}

async function syncCurrencies() {
  const Currency = rawModel('Currency', 'currencies');
  const docs = await Currency.find({}).lean();
  console.log(`Currencies: ${docs.length}`);
  if (DRY_RUN) return docs.length;

  let upserted = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    await prisma.currency.upsert({
      where: { id },
      create: {
        id,
        code: String(doc.code || id.slice(-3)).toUpperCase(),
        name: doc.name,
        symbol: doc.symbol || null,
        decimalPlaces: doc.decimal_places ?? doc.decimalPlaces ?? 2,
        isActive: doc.is_active !== false && doc.isActive !== false,
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        name: doc.name,
        symbol: doc.symbol || null,
        decimalPlaces: doc.decimal_places ?? doc.decimalPlaces ?? 2,
        isActive: doc.is_active !== false && doc.isActive !== false,
      },
    });
    upserted += 1;
  }
  return upserted;
}

async function syncDepartments() {
  const Department = rawModel('Department', 'departments');
  const docs = await Department.find({}).lean();
  console.log(`Departments: ${docs.length}`);
  if (DRY_RUN) return docs.length;

  let upserted = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    if (!(await companyExists(companyId))) continue;

    await prisma.department.upsert({
      where: { id },
      create: {
        id,
        companyId,
        code: String(doc.code || '').toUpperCase(),
        name: doc.name,
        description: doc.description || null,
        managerId: oid(doc.manager),
        defaultLaborAccount: doc.defaultLaborAccount || '5400',
        budgetLimit: dec(doc.budgetLimit, 0),
        isActive: doc.isActive !== false,
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        name: doc.name,
        description: doc.description || null,
        managerId: oid(doc.manager),
        budgetLimit: dec(doc.budgetLimit, 0),
        isActive: doc.isActive !== false,
      },
    });
    upserted += 1;
  }
  return upserted;
}

async function syncCategories() {
  const Category = rawModel('Category', 'categories');
  const docs = await Category.find({}).lean();
  console.log(`Categories: ${docs.length}`);
  if (DRY_RUN) return docs.length;

  let upserted = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    if (!(await companyExists(companyId))) continue;

    await prisma.category.upsert({
      where: { id },
      create: {
        id,
        companyId,
        name: doc.name,
        description: doc.description || null,
        parentId: null,
        defaultInventoryAccount: doc.defaultInventoryAccount || null,
        defaultCogsAccount: doc.defaultCogsAccount || null,
        defaultRevenueAccount: doc.defaultRevenueAccount || null,
        isActive: doc.isActive !== false,
        createdById: oid(doc.createdBy),
        customFields: doc.customFields || {},
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        name: doc.name,
        description: doc.description || null,
        defaultInventoryAccount: doc.defaultInventoryAccount || null,
        defaultCogsAccount: doc.defaultCogsAccount || null,
        defaultRevenueAccount: doc.defaultRevenueAccount || null,
        isActive: doc.isActive !== false,
        customFields: doc.customFields || {},
      },
    });
    upserted += 1;
  }

  for (const doc of docs) {
    const parentId = oid(doc.parent);
    if (!parentId) continue;
    const parentExists = await prisma.category.findUnique({ where: { id: parentId }, select: { id: true } });
    if (!parentExists) continue;
    await prisma.category.update({
      where: { id: oid(doc._id) },
      data: { parentId },
    });
  }
  return upserted;
}

async function syncChartOfAccounts() {
  const ChartOfAccount = rawModel('ChartOfAccount', 'chartofaccounts');
  const docs = await ChartOfAccount.find({}).lean();
  console.log(`ChartOfAccounts: ${docs.length}`);
  if (DRY_RUN) return docs.length;

  let upserted = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    if (!(await companyExists(companyId))) continue;

    await prisma.chartOfAccount.upsert({
      where: { id },
      create: {
        id,
        companyId,
        code: doc.code,
        name: doc.name,
        type: doc.type || 'asset',
        subtype: doc.subtype || null,
        normalBalance: doc.normal_balance || doc.normalBalance || 'debit',
        parentId: null,
        allowDirectPosting: doc.allow_direct_posting !== false && doc.allowDirectPosting !== false,
        isActive: doc.isActive !== false,
        createdById: oid(doc.createdBy),
        customFields: doc.customFields || {},
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        name: doc.name,
        type: doc.type || 'asset',
        subtype: doc.subtype || null,
        normalBalance: doc.normal_balance || doc.normalBalance || 'debit',
        allowDirectPosting: doc.allow_direct_posting !== false && doc.allowDirectPosting !== false,
        isActive: doc.isActive !== false,
        customFields: doc.customFields || {},
      },
    });
    upserted += 1;
  }

  for (const doc of docs) {
    const parentId = oid(doc.parent_id || doc.parent);
    if (!parentId) continue;
    const parentExists = await prisma.chartOfAccount.findUnique({ where: { id: parentId }, select: { id: true } });
    if (!parentExists) continue;
    await prisma.chartOfAccount.update({
      where: { id: oid(doc._id) },
      data: { parentId },
    });
  }
  return upserted;
}

async function syncWarehouses() {
  const Warehouse = rawModel('Warehouse', 'warehouses');
  const docs = await Warehouse.find({}).lean();
  console.log(`Warehouses: ${docs.length}`);
  if (DRY_RUN) return docs.length;

  let upserted = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    if (!(await companyExists(companyId))) continue;

    await prisma.warehouse.upsert({
      where: { id },
      create: {
        id,
        companyId,
        name: doc.name,
        code: String(doc.code || '').toUpperCase(),
        description: doc.description || null,
        location: doc.location || {},
        inventoryAccount: doc.inventoryAccount || null,
        isActive: doc.isActive !== false,
        isDefault: Boolean(doc.isDefault),
        totalProducts: doc.totalProducts ?? 0,
        totalValue: dec(doc.totalValue, 0),
        createdById: oid(doc.createdBy),
        customFields: doc.customFields || {},
        rraBranchId: doc.rraBranchId || null,
        ebmRegistrationStatus: doc.ebmRegistrationStatus || 'not_registered',
        ebmRegisteredAt: doc.ebmRegisteredAt || null,
        ebmLastAttemptAt: doc.ebmLastAttemptAt || null,
        ebmRegistrationError: doc.ebmRegistrationError || null,
        ebmUsersSubmitted: Boolean(doc.ebmUsersSubmitted),
        ebmInsurances: doc.ebmInsurances || [],
        ebmInsuranceSubmitted: Boolean(doc.ebmInsuranceSubmitted),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        name: doc.name,
        description: doc.description || null,
        location: doc.location || {},
        isActive: doc.isActive !== false,
        isDefault: Boolean(doc.isDefault),
        totalProducts: doc.totalProducts ?? 0,
        totalValue: dec(doc.totalValue, 0),
        customFields: doc.customFields || {},
      },
    });
    upserted += 1;
  }
  return upserted;
}

async function syncSuppliers() {
  const Supplier = rawModel('Supplier', 'suppliers');
  const docs = await Supplier.find({}).lean();
  console.log(`Suppliers: ${docs.length}`);
  if (DRY_RUN) return docs.length;

  let upserted = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    if (!(await companyExists(companyId))) continue;

    await prisma.supplier.upsert({
      where: { id },
      create: {
        id,
        companyId,
        name: doc.name,
        code: String(doc.code || '').toUpperCase(),
        contact: doc.contact || {},
        region: doc.region || null,
        currency: doc.currency || null,
        leadTime: doc.leadTime ?? null,
        minimumOrder: doc.minimumOrder != null ? dec(doc.minimumOrder) : null,
        bankName: doc.bankName || null,
        bankAccount: doc.bankAccount || null,
        productsSupplied: (doc.productsSupplied || []).map(oid).filter(Boolean),
        paymentTerms: doc.paymentTerms || 'cash',
        taxId: doc.taxId || null,
        notes: doc.notes || null,
        isActive: doc.isActive !== false,
        totalPurchases: dec(doc.totalPurchases, 0),
        lastPurchaseDate: doc.lastPurchaseDate || null,
        createdById: oid(doc.createdBy),
        customFields: doc.customFields || {},
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        name: doc.name,
        contact: doc.contact || {},
        isActive: doc.isActive !== false,
        totalPurchases: dec(doc.totalPurchases, 0),
        productsSupplied: (doc.productsSupplied || []).map(oid).filter(Boolean),
        customFields: doc.customFields || {},
      },
    });
    upserted += 1;
  }
  return upserted;
}

async function syncClients() {
  const Client = rawModel('Client', 'clients');
  const docs = await Client.find({}).lean();
  console.log(`Clients: ${docs.length}`);
  if (DRY_RUN) return docs.length;

  let upserted = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    if (!(await companyExists(companyId))) continue;

    await prisma.client.upsert({
      where: { id },
      create: {
        id,
        companyId,
        name: doc.name,
        code: String(doc.code || '').toUpperCase(),
        type: doc.type || 'individual',
        contact: doc.contact || {},
        salesArea: doc.salesArea || null,
        salesRepId: doc.salesRepId || null,
        region: doc.region || null,
        industry: doc.industry || null,
        registrationDate: doc.registrationDate || null,
        taxId: doc.taxId || null,
        ebmTinVerification: doc.ebmTinVerification || null,
        paymentTerms: doc.paymentTerms || 'cash',
        creditLimit: dec(doc.creditLimit, 0),
        outstandingBalance: dec(doc.outstandingBalance, 0),
        totalPurchases: dec(doc.totalPurchases, 0),
        lastPurchaseDate: doc.lastPurchaseDate || null,
        notes: doc.notes || null,
        isActive: doc.isActive !== false,
        createdById: oid(doc.createdBy),
        customFields: doc.customFields || {},
        ebmBranchCustomers: doc.ebmBranchCustomers || [],
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        name: doc.name,
        contact: doc.contact || {},
        isActive: doc.isActive !== false,
        creditLimit: dec(doc.creditLimit, 0),
        outstandingBalance: dec(doc.outstandingBalance, 0),
        totalPurchases: dec(doc.totalPurchases, 0),
        customFields: doc.customFields || {},
        ebmBranchCustomers: doc.ebmBranchCustomers || [],
      },
    });
    upserted += 1;
  }
  return upserted;
}

async function syncProducts() {
  const Product = rawModel('Product', 'products');
  const docs = await Product.find({}).lean();
  console.log(`Products: ${docs.length}`);
  if (DRY_RUN) return docs.length;

  let upserted = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const categoryId = oid(doc.category);
    if (!(await companyExists(companyId))) continue;
    if (!categoryId) continue;
    const categoryExists = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } });
    if (!categoryExists) continue;

    const supplierId = oid(doc.supplier);
    const preferredSupplierId = oid(doc.preferredSupplier);
    const defaultWarehouseId = oid(doc.defaultWarehouse);

    await prisma.product.upsert({
      where: { id },
      create: {
        id,
        companyId,
        name: doc.name,
        sku: String(doc.sku || '').toUpperCase(),
        barcode: doc.barcode || null,
        barcodeType: doc.barcodeType || 'CODE128',
        description: doc.description || null,
        categoryId,
        unit: doc.unit || 'pcs',
        supplierId: supplierId || null,
        currentStock: dec(doc.currentStock, 0),
        reservedQuantity: dec(doc.reservedQuantity, 0),
        isActive: doc.isActive !== false,
        isStockable: doc.isStockable !== false,
        lowStockThreshold: dec(doc.lowStockThreshold, 10),
        averageCost: dec(doc.averageCost, 0),
        sellingPrice: dec(doc.sellingPrice, 0),
        costPrice: dec(doc.costPrice, 0),
        lastSupplyDate: doc.lastSupplyDate || null,
        lastSaleDate: doc.lastSaleDate || null,
        costingMethod: doc.costingMethod || 'fifo',
        inventoryAccount: doc.inventoryAccount || null,
        cogsAccount: doc.cogsAccount || null,
        revenueAccount: doc.revenueAccount || null,
        isArchived: Boolean(doc.isArchived),
        weight: doc.weight ?? 0,
        brand: doc.brand || null,
        location: doc.location || null,
        trackingType: doc.trackingType || 'none',
        trackBatch: Boolean(doc.trackBatch),
        trackSerialNumbers: Boolean(doc.trackSerialNumbers),
        reorderPoint: dec(doc.reorderPoint, 0),
        reorderQuantity: dec(doc.reorderQuantity, 0),
        defaultWarehouseId: defaultWarehouseId || null,
        preferredSupplierId: preferredSupplierId || null,
        taxCode: doc.taxCode || 'A',
        taxRate: dec(doc.taxRate, 0),
        ebm: doc.ebm || {},
        history: doc.history || [],
        createdById: oid(doc.createdBy),
        customFields: doc.customFields || {},
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        name: doc.name,
        description: doc.description || null,
        currentStock: dec(doc.currentStock, 0),
        reservedQuantity: dec(doc.reservedQuantity, 0),
        isActive: doc.isActive !== false,
        isArchived: Boolean(doc.isArchived),
        averageCost: dec(doc.averageCost, 0),
        sellingPrice: dec(doc.sellingPrice, 0),
        costPrice: dec(doc.costPrice, 0),
        ebm: doc.ebm || {},
        history: doc.history || [],
        customFields: doc.customFields || {},
      },
    });
    upserted += 1;
  }
  return upserted;
}

async function syncTaxes() {
  const Tax = rawModel('Tax', 'taxes');
  const docs = await Tax.find({}).lean();
  console.log(`Taxes: ${docs.length}`);
  if (DRY_RUN) return docs.length;

  let upserted = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    if (!(await companyExists(companyId))) continue;

    await prisma.tax.upsert({
      where: { id },
      create: {
        id,
        companyId,
        taxType: doc.taxType,
        vatRate: doc.vatRate ?? 18,
        vatOutput: dec(doc.vatOutput, 0),
        vatInput: dec(doc.vatInput, 0),
        vatNet: dec(doc.vatNet, 0),
        vatPeriod: doc.vatPeriod || null,
        corporateIncomeRate: doc.corporateIncomeRate ?? 30,
        taxableIncome: dec(doc.taxableIncome, 0),
        taxOwed: dec(doc.taxOwed, 0),
        payeCollected: dec(doc.payeCollected, 0),
        payePaid: dec(doc.payePaid, 0),
        payePeriod: doc.payePeriod || null,
        withholdingCollected: dec(doc.withholdingCollected, 0),
        withholdingPaid: dec(doc.withholdingPaid, 0),
        tradingLicenseFee: dec(doc.tradingLicenseFee, 0),
        tradingLicenseYear: doc.tradingLicenseYear ?? null,
        tradingLicenseStatus: doc.tradingLicenseStatus || 'not_applicable',
        payments: doc.payments || [],
        filings: doc.filings || [],
        calendar: doc.calendar || [],
        status: doc.status || 'active',
        notes: doc.notes || null,
        createdById: oid(doc.createdBy),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        vatOutput: dec(doc.vatOutput, 0),
        vatInput: dec(doc.vatInput, 0),
        vatNet: dec(doc.vatNet, 0),
        taxableIncome: dec(doc.taxableIncome, 0),
        taxOwed: dec(doc.taxOwed, 0),
        status: doc.status || 'active',
        payments: doc.payments || [],
        filings: doc.filings || [],
        calendar: doc.calendar || [],
      },
    });
    upserted += 1;
  }
  return upserted;
}

async function syncTaxRates() {
  const TaxRate = rawModel('TaxRate', 'taxrates');
  const docs = await TaxRate.find({}).lean();
  console.log(`TaxRates: ${docs.length}`);
  if (DRY_RUN) return docs.length;

  let upserted = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const inputAccountId = oid(doc.input_account_id);
    const outputAccountId = oid(doc.output_account_id);
    if (!(await companyExists(companyId))) continue;
    if (!inputAccountId || !outputAccountId) continue;

    await prisma.taxRate.upsert({
      where: { id },
      create: {
        id,
        companyId,
        name: doc.name,
        code: String(doc.code || '').toUpperCase(),
        ratePct: doc.rate_pct ?? doc.ratePct ?? 0,
        type: doc.type,
        inputAccountId,
        outputAccountId,
        inputAccountCode: doc.input_account_code || doc.inputAccountCode,
        outputAccountCode: doc.output_account_code || doc.outputAccountCode,
        isActive: doc.is_active !== false && doc.isActive !== false,
        effectiveFrom: doc.effective_from || doc.effectiveFrom || new Date(),
        effectiveTo: doc.effective_to || doc.effectiveTo || null,
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        name: doc.name,
        ratePct: doc.rate_pct ?? doc.ratePct ?? 0,
        isActive: doc.is_active !== false && doc.isActive !== false,
        effectiveFrom: doc.effective_from || doc.effectiveFrom || new Date(),
        effectiveTo: doc.effective_to || doc.effectiveTo || null,
      },
    });
    upserted += 1;
  }
  return upserted;
}

async function syncExchangeRates() {
  const ExchangeRate = rawModel('ExchangeRate', 'exchangerates');
  const docs = await ExchangeRate.find({}).lean();
  console.log(`ExchangeRates: ${docs.length}`);
  if (DRY_RUN) return docs.length;

  let upserted = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company_id || doc.company);
    if (!(await companyExists(companyId))) continue;

    await prisma.exchangeRate.upsert({
      where: { id },
      create: {
        id,
        companyId,
        fromCurrency: String(doc.from_currency || doc.fromCurrency).toUpperCase(),
        toCurrency: String(doc.to_currency || doc.toCurrency).toUpperCase(),
        rate: dec(doc.rate, 1),
        effectiveDate: doc.effective_date || doc.effectiveDate || new Date(),
        source: doc.source || 'manual',
        createdById: oid(doc.created_by || doc.createdBy),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        rate: dec(doc.rate, 1),
        effectiveDate: doc.effective_date || doc.effectiveDate || new Date(),
        source: doc.source || 'manual',
      },
    });
    upserted += 1;
  }
  return upserted;
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI required');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');

  console.log(DRY_RUN ? '=== DRY RUN Phase 2 ===' : '=== SYNC Phase 2 Mongo → Postgres ===');
  await mongoose.connect(process.env.MONGODB_URI);
  await connectPrisma();

  const results = {
    currencies: await syncCurrencies(),
    departments: await syncDepartments(),
    categories: await syncCategories(),
    chartOfAccounts: await syncChartOfAccounts(),
    warehouses: await syncWarehouses(),
    suppliers: await syncSuppliers(),
    clients: await syncClients(),
    products: await syncProducts(),
    taxes: await syncTaxes(),
    taxRates: await syncTaxRates(),
    exchangeRates: await syncExchangeRates(),
  };

  console.log('Done:', results);
  await disconnectPrisma();
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await disconnectPrisma();
    await mongoose.disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
