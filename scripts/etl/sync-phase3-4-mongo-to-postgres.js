/**
 * ETL: Sync Phase 3 (inventory) + Phase 4 (journal) from MongoDB → PostgreSQL.
 *
 * Usage:
 *   node scripts/etl/sync-phase3-4-mongo-to-postgres.js
 *   node scripts/etl/sync-phase3-4-mongo-to-postgres.js --dry-run
 *
 * Requires: MONGODB_URI and DATABASE_URL
 */
require('dotenv').config();

const mongoose = require('mongoose');
const { prisma, connectPrisma, disconnectPrisma } = require('../../lib/prisma');

const DRY_RUN = process.argv.includes('--dry-run');

function rawModel(name, collection) {
  const modelName = `EtlPhase34${name}`;
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

async function upsertSimple(model, collection, mapFn, label) {
  const M = rawModel(model, collection);
  const docs = await M.find({}).lean();
  console.log(`${label}: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const mapped = await mapFn(doc);
    if (!mapped) continue;
    await prisma[model.charAt(0).toLowerCase() + model.slice(1).replace(/([A-Z])/g, (m, c) => c)].upsert?.({
      where: { id: mapped.id || mapped.where?.id },
      create: mapped.create || mapped,
      update: mapped.update || mapped,
    });
    n += 1;
  }
  return n;
}

async function refExists(model, id) {
  if (!id) return false;
  const row = await prisma[model].findUnique({ where: { id }, select: { id: true } });
  return Boolean(row);
}

async function syncStockLevels() {
  const M = rawModel('StockLevel', 'stocklevels');
  const docs = await M.find({}).lean();
  console.log(`StockLevels: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company_id || doc.company);
    const productId = oid(doc.product_id || doc.product);
    const warehouseId = oid(doc.warehouse_id || doc.warehouse);
    if (!(await companyExists(companyId))) continue;
    if (!(await refExists('product', productId))) continue;
    if (!(await refExists('warehouse', warehouseId))) continue;
    await prisma.stockLevel.upsert({
      where: { id },
      create: {
        id,
        companyId,
        productId,
        warehouseId,
        qtyOnHand: dec(doc.qty_on_hand, 0),
        qtyReserved: dec(doc.qty_reserved, 0),
        qtyOnOrder: dec(doc.qty_on_order, 0),
        avgCost: dec(doc.avg_cost, 0),
        totalValue: dec(doc.total_value, 0),
        lastCountedAt: doc.last_counted_at || null,
        lastCountedById: oid(doc.last_counted_by),
        lastMovementAt: doc.last_movement_at || null,
        lastMovementType: doc.last_movement_type || null,
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        qtyOnHand: dec(doc.qty_on_hand, 0),
        qtyReserved: dec(doc.qty_reserved, 0),
        qtyOnOrder: dec(doc.qty_on_order, 0),
        avgCost: dec(doc.avg_cost, 0),
        totalValue: dec(doc.total_value, 0),
        lastMovementAt: doc.last_movement_at || null,
      },
    });
    n += 1;
  }
  return n;
}

async function syncStockMovements() {
  const M = rawModel('StockMovement', 'stockmovements');
  const docs = await M.find({}).lean();
  console.log(`StockMovements: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company_id || doc.company);
    const productId = oid(doc.product_id || doc.product);
    if (!(await companyExists(companyId))) continue;
    if (productId && !(await refExists('product', productId))) continue;
    await prisma.stockMovement.upsert({
      where: { id },
      create: {
        id,
        companyId,
        productId,
        type: doc.type,
        reason: doc.reason,
        quantity: dec(doc.quantity, 0),
        previousStock: dec(doc.previousStock, 0),
        newStock: dec(doc.newStock, 0),
        unitCost: dec(doc.unitCost, 0),
        totalCost: dec(doc.totalCost, 0),
        supplierId: oid(doc.supplier),
        warehouseId: oid(doc.warehouse),
        batchNumber: doc.batchNumber || null,
        lotNumber: doc.lotNumber || null,
        expiryDate: doc.expiryDate || null,
        referenceType: doc.referenceType || null,
        referenceNumber: doc.referenceNumber || null,
        referenceDocumentId: oid(doc.referenceDocument),
        referenceModel: doc.referenceModel || null,
        notes: doc.notes || null,
        performedById: oid(doc.performedBy),
        movementDate: doc.movementDate || doc.createdAt || new Date(),
        ebm: doc.ebm || {},
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        quantity: dec(doc.quantity, 0),
        newStock: dec(doc.newStock, 0),
        totalCost: dec(doc.totalCost, 0),
      },
    });
    n += 1;
  }
  return n;
}

async function syncJournalEntries() {
  const M = rawModel('JournalEntry', 'journalentries');
  const docs = await M.find({}).lean();
  console.log(`JournalEntries: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    if (!(await companyExists(companyId))) continue;
    const createdById = oid(doc.createdBy) || oid(doc.postedBy);
    if (!createdById) continue;
    const lines = Array.isArray(doc.lines) ? doc.lines : [];
    const sumDebit = lines.reduce((s, l) => s + Number(dec(l.debit, 0)), 0);
    const sumCredit = lines.reduce((s, l) => s + Number(dec(l.credit, 0)), 0);
    await prisma.journalEntry.upsert({
      where: { id },
      create: {
        id,
        companyId,
        entryNumber: doc.entryNumber,
        date: doc.date || new Date(),
        description: doc.description || '',
        sourceType: doc.sourceType || null,
        sourceId: doc.sourceId != null ? String(doc.sourceId) : null,
        sourceReference: doc.sourceReference || doc.reference || null,
        reference: doc.reference || doc.sourceReference || null,
        status: doc.status || 'posted',
        totalDebit: sumDebit.toFixed(2),
        totalCredit: sumCredit.toFixed(2),
        debitTotal: sumDebit.toFixed(2),
        creditTotal: sumCredit.toFixed(2),
        isAutoGenerated: Boolean(doc.isAutoGenerated),
        reversalOfId: oid(doc.reversalOf),
        createdById,
        postedById: oid(doc.postedBy),
        notes: doc.notes || null,
        reversed: Boolean(doc.reversed),
        reconciliationStatus: doc.reconciliationStatus || 'unreconciled',
        isLocked: Boolean(doc.isLocked),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        status: doc.status || 'posted',
        totalDebit: sumDebit.toFixed(2),
        totalCredit: sumCredit.toFixed(2),
      },
    });
    await prisma.journalEntryLine.deleteMany({ where: { journalEntryId: id } });
    if (lines.length) {
      const { generateObjectId } = require('../../utils/objectId');
      await prisma.journalEntryLine.createMany({
        data: lines.map((line, idx) => ({
          id: generateObjectId(),
          companyId,
          journalEntryId: id,
          lineOrder: idx,
          accountCode: line.accountCode,
          accountName: line.accountName || line.accountCode,
          description: line.description || null,
          debit: Number(dec(line.debit, 0)).toFixed(2),
          credit: Number(dec(line.credit, 0)).toFixed(2),
          reference: line.reference || null,
          reconciled: Boolean(line.reconciled),
          matchedStatementLineId: oid(line.matchedStatementLineId),
        })),
      });
    }
    n += 1;
  }
  return n;
}

async function syncAccountBalances() {
  const M = rawModel('AccountBalance', 'accountbalances');
  const docs = await M.find({}).lean();
  console.log(`AccountBalances: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    if (!(await companyExists(companyId))) continue;
    await prisma.accountBalance.upsert({
      where: { companyId_accountCode: { companyId, accountCode: doc.accountCode } },
      create: {
        id,
        companyId,
        accountCode: doc.accountCode,
        debit: dec(doc.debit, 0),
        credit: dec(doc.credit, 0),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        debit: dec(doc.debit, 0),
        credit: dec(doc.credit, 0),
        updatedAt: doc.updatedAt || new Date(),
      },
    });
    n += 1;
  }
  return n;
}

async function syncAccountingPeriods() {
  const M = rawModel('AccountingPeriod', 'accountingperiods');
  const docs = await M.find({}).lean();
  console.log(`AccountingPeriods: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company_id || doc.company);
    if (!(await companyExists(companyId))) continue;
    await prisma.accountingPeriod.upsert({
      where: { id },
      create: {
        id,
        companyId,
        name: doc.name,
        periodType: doc.period_type || doc.periodType || 'month',
        startDate: doc.start_date || doc.startDate,
        endDate: doc.end_date || doc.endDate,
        fiscalYear: doc.fiscal_year || doc.fiscalYear || new Date().getFullYear(),
        status: doc.status || 'open',
        closedById: oid(doc.closed_by || doc.closedBy),
        closedAt: doc.closed_at || doc.closedAt || null,
        yearEndCloseEntryId: oid(doc.year_end_close_entry_id),
        isYearEnd: Boolean(doc.is_year_end || doc.isYearEnd),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: { status: doc.status || 'open' },
    });
    n += 1;
  }
  return n;
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is required for ETL');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  await connectPrisma();
  console.log(DRY_RUN ? 'DRY RUN' : 'SYNC');

  const results = {
    stockLevels: await syncStockLevels(),
    stockMovements: await syncStockMovements(),
    journalEntries: await syncJournalEntries(),
    accountBalances: await syncAccountBalances(),
    accountingPeriods: await syncAccountingPeriods(),
  };
  console.log('Done:', results);

  await mongoose.disconnect();
  await disconnectPrisma();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  await disconnectPrisma().catch(() => {});
  process.exit(1);
});
