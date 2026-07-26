/**
 * Compare MongoDB vs PostgreSQL document counts for migrated collections.
 *
 * Usage:
 *   node scripts/etl/verify-parity.js
 *   node scripts/etl/verify-parity.js --phase=10
 *   node scripts/etl/verify-parity.js --phase=10 --company=507f1f77bcf86cd799439011
 *
 * Requires: MONGODB_URI and DATABASE_URL
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { prisma, connectPrisma, disconnectPrisma } = require('../../lib/prisma');

const SKIP_LOG = path.join(__dirname, 'etl_skipped.log');

const PHASE_ENTITIES = {
  10: [
    { label: 'AssetCategory', mongo: 'assetcategories', prisma: 'assetCategory' },
    { label: 'FixedAsset', mongo: 'fixedassets', prisma: 'fixedAsset' },
    { label: 'DepreciationEntry', mongo: 'depreciationentries', prisma: 'depreciationEntry' },
    { label: 'AssetDisposalEvent', mongo: 'assetdisposalevents', prisma: 'assetDisposalEvent' },
    { label: 'AssetStatusHistory', mongo: 'assetstatushistories', prisma: 'assetStatusHistory' },
    { label: 'Employee', mongo: 'employees', prisma: 'employee' },
    { label: 'SalaryHistory', mongo: 'salaryhistories', prisma: 'salaryHistory' },
    { label: 'PayrollRun', mongo: 'payrollruns', prisma: 'payrollRun' },
    { label: 'Payroll', mongo: 'payrolls', prisma: 'payroll' },
    { label: 'Timesheet', mongo: 'timesheets', prisma: 'timesheet' },
    { label: 'EmployeeAdvance', mongo: 'employeeadvances', prisma: 'employeeAdvance' },
    { label: 'Project', mongo: 'projects', prisma: 'project' },
    { label: 'Budget', mongo: 'budgets', prisma: 'budget' },
    { label: 'BudgetLine', mongo: 'budgetlines', prisma: 'budgetLine' },
    { label: 'BudgetWorkflowConfig', mongo: 'budgetworkflowconfigs', prisma: 'budgetWorkflowConfig' },
    { label: 'BudgetActualConsumption', mongo: 'budgetactualconsumptions', prisma: 'budgetActualConsumption' },
    { label: 'BudgetTransfer', mongo: 'budgettransfers', prisma: 'budgetTransfer' },
    { label: 'BudgetRevision', mongo: 'budgetrevisions', prisma: 'budgetRevision' },
    { label: 'BudgetPeriodLock', mongo: 'budgetperiodlocks', prisma: 'budgetPeriodLock' },
    { label: 'BudgetApproval', mongo: 'budgetapprovals', prisma: 'budgetApproval' },
    { label: 'BudgetAlert', mongo: 'budgetalerts', prisma: 'budgetAlert' },
    { label: 'Encumbrance', mongo: 'encumbrances', prisma: 'encumbrance' },
    { label: 'EbmDevice', mongo: 'ebmdevices', prisma: 'ebmDevice' },
    { label: 'EbmCode', mongo: 'ebmcodes', prisma: 'ebmCode' },
    { label: 'EbmItemClass', mongo: 'ebmitemclasses', prisma: 'ebmItemClass' },
    { label: 'EbmTin', mongo: 'ebmtins', prisma: 'ebmTin', global: true },
    { label: 'EbmNotice', mongo: 'ebmnotices', prisma: 'ebmNotice' },
    { label: 'EbmImportedItem', mongo: 'ebmimporteditems', prisma: 'ebmImportedItem' },
    { label: 'EbmUnmatchedPurchase', mongo: 'ebmunmatchedpurchases', prisma: 'ebmUnmatchedPurchase' },
    { label: 'EbmSubmissionQueue', mongo: 'ebmsubmissionqueues', prisma: 'ebmSubmissionQueue' },
    { label: 'EbmAlert', mongo: 'ebmalerts', prisma: 'ebmAlert' },
    { label: 'EbmSyncState', mongo: 'ebmsyncstates', prisma: 'ebmSyncState' },
  ],
};

function parseArg(prefix) {
  const arg = process.argv.find((a) => a.startsWith(`${prefix}=`));
  return arg ? arg.slice(prefix.length + 1) : null;
}

const PHASE = parseInt(parseArg('--phase') || '10', 10);
const COMPANY_ID = parseArg('--company');

function rawModel(name, collection) {
  const modelName = `VerifyParity${name}`;
  if (mongoose.models[modelName]) return mongoose.models[modelName];
  return mongoose.model(modelName, new mongoose.Schema({}, { strict: false, collection }));
}

function mongoCompanyFilter(companyId) {
  if (!companyId) return {};
  return {
    $or: [
      { company: companyId },
      { company: new mongoose.Types.ObjectId(companyId) },
      { companyId: companyId },
      { company_id: companyId },
    ],
  };
}

function logMismatch(entity, mongoCount, pgCount, companyId) {
  const scope = companyId ? `company=${companyId}` : 'all';
  const msg = `${entity}: mongo=${mongoCount} postgres=${pgCount} (${scope})`;
  console.error(`MISMATCH ${msg}`);
  const line = `${new Date().toISOString()}\tparity\tphase${PHASE}\t${entity}\t${scope}\tmongo=${mongoCount}\tpostgres=${pgCount}\n`;
  fs.appendFileSync(SKIP_LOG, line);
}

async function countMongo(entity, companyId) {
  const M = rawModel(entity.label, entity.mongo);
  const filter = entity.global ? {} : mongoCompanyFilter(companyId);
  return M.countDocuments(filter);
}

async function countPostgres(entity, companyId) {
  if (entity.global || !companyId) {
    return prisma[entity.prisma].count();
  }
  return prisma[entity.prisma].count({ where: { companyId } });
}

async function main() {
  const entities = PHASE_ENTITIES[PHASE];
  if (!entities) {
    console.error(`Unknown phase: ${PHASE}`);
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI required');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  await connectPrisma();

  console.log(`Parity check phase ${PHASE}${COMPANY_ID ? ` company ${COMPANY_ID}` : ''}`);
  let mismatches = 0;

  for (const entity of entities) {
    const mongoCount = await countMongo(entity, COMPANY_ID);
    const pgCount = await countPostgres(entity, COMPANY_ID);
    const ok = mongoCount === pgCount;
    console.log(`${ok ? 'OK' : 'FAIL'} ${entity.label}: mongo=${mongoCount} postgres=${pgCount}`);
    if (!ok) {
      mismatches += 1;
      logMismatch(entity.label, mongoCount, pgCount, COMPANY_ID);
    }
  }

  console.log(mismatches === 0 ? 'All counts match.' : `${mismatches} mismatch(es) — see console and ${SKIP_LOG}`);
  await mongoose.disconnect();
  await disconnectPrisma();
  process.exit(mismatches > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  await disconnectPrisma().catch(() => {});
  process.exit(1);
});
