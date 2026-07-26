/**
 * ETL: Sync Phase 10 (Fixed Assets, HR/Payroll, Budget, EBM) MongoDB → PostgreSQL.
 *
 * Usage:
 *   node scripts/etl/sync-phase10-mongo-to-postgres.js
 *   node scripts/etl/sync-phase10-mongo-to-postgres.js --dry-run
 *
 * Requires: MONGODB_URI and DATABASE_URL
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { toPlainJson } = require('../../utils/objectId');
const { prisma, connectPrisma, disconnectPrisma } = require('../../lib/prisma');
const {
  assetCategoryTranslateCreate,
  fixedAssetTranslateCreate,
  depreciationEntryTranslateCreate,
  assetDisposalEventTranslateCreate,
  assetStatusHistoryTranslateCreate,
  employeeTranslateCreate,
  salaryHistoryTranslateCreate,
  payrollRunTranslateCreate,
  payrollTranslateCreate,
  timesheetTranslateCreate,
  employeeAdvanceTranslateCreate,
  projectTranslateCreate,
  budgetTranslateCreate,
  budgetLineTranslateCreate,
  budgetWorkflowConfigTranslateCreate,
  budgetActualConsumptionTranslateCreate,
  budgetTransferTranslateCreate,
  budgetRevisionTranslateCreate,
  budgetPeriodLockTranslateCreate,
  budgetApprovalTranslateCreate,
  budgetAlertTranslateCreate,
  encumbranceTranslateCreate,
  ebmDeviceTranslateCreate,
  ebmCodeTranslateCreate,
  ebmItemClassTranslateCreate,
  ebmTinTranslateCreate,
  ebmNoticeTranslateCreate,
  ebmImportedItemTranslateCreate,
  ebmUnmatchedPurchaseTranslateCreate,
  ebmSubmissionQueueTranslateCreate,
  ebmAlertTranslateCreate,
  ebmSyncStateTranslateCreate,
} = require('../../utils/phase10Mappers');

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_LOG = path.join(__dirname, 'etl_skipped.log');

function rawModel(name, collection) {
  const modelName = `EtlPhase10${name}`;
  if (mongoose.models[modelName]) return mongoose.models[modelName];
  return mongoose.model(modelName, new mongoose.Schema({}, { strict: false, collection }));
}

function oid(v) { return v == null ? null : String(v); }

function resolveCompanyId(doc) {
  return oid(doc.company || doc.companyId || doc.company_id);
}

function logSkip(entity, id, reason) {
  const line = `${new Date().toISOString()}\tphase10\t${entity}\t${id || 'unknown'}\t${reason}\n`;
  fs.appendFileSync(SKIP_LOG, line);
}

async function companyExists(id) {
  if (!id) return false;
  return Boolean(await prisma.company.findUnique({ where: { id }, select: { id: true } }));
}

async function refExists(model, id) {
  if (!id) return false;
  return Boolean(await prisma[model].findUnique({ where: { id }, select: { id: true } }));
}

async function optionalRef(model, id) {
  if (!id) return null;
  return (await refExists(model, id)) ? id : null;
}

function timestamps(doc) {
  return {
    createdAt: doc.createdAt || new Date(),
    updatedAt: doc.updatedAt || new Date(),
  };
}

const KEEP_CREATED_BY = new Set([
  'assetCategory', 'fixedAsset', 'employee', 'payroll', 'timesheet', 'employeeAdvance',
  'budget', 'budgetWorkflowConfig', 'budgetActualConsumption', 'budgetPeriodLock',
  'budgetAlert', 'encumbrance', 'ebmDevice',
]);

function preparePayload(model, payload) {
  const p = toPlainJson({ ...payload });
  if (!KEEP_CREATED_BY.has(model)) delete p.createdById;
  if (model === 'ebmTin') {
    delete p.companyId;
    delete p.createdById;
  }
  return p;
}

async function upsertRow(model, id, create, update) {
  await prisma[model].upsert({
    where: { id },
    create: preparePayload(model, create),
    update,
  });
}

async function syncAssetCategories() {
  const M = rawModel('AssetCategory', 'assetcategories');
  const docs = await M.find({}).lean();
  console.log(`AssetCategories: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('AssetCategory', id, 'missing company');
      continue;
    }
    const mapped = assetCategoryTranslateCreate(doc);
    mapped.parentCategoryId = await optionalRef('assetCategory', mapped.parentCategoryId);
    await upsertRow('assetCategory', id, { ...mapped, ...timestamps(doc) }, {
      name: mapped.name,
      isDeleted: mapped.isDeleted ?? false,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncFixedAssets() {
  const M = rawModel('FixedAsset', 'fixedassets');
  const docs = await M.find({}).lean();
  console.log(`FixedAssets: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('FixedAsset', id, 'missing company');
      continue;
    }
    const mapped = fixedAssetTranslateCreate(doc);
    if (!mapped.createdById) {
      logSkip('FixedAsset', id, 'missing createdBy');
      continue;
    }
    mapped.categoryId = await optionalRef('assetCategory', mapped.categoryId);
    mapped.disposalCustomerId = await optionalRef('client', mapped.disposalCustomerId);
    mapped.disposalEventId = await optionalRef('assetDisposalEvent', mapped.disposalEventId);
    mapped.disposalJournalEntryId = await optionalRef('journalEntry', mapped.disposalJournalEntryId);
    mapped.supplierId = await optionalRef('supplier', mapped.supplierId);
    mapped.custodianId = await optionalRef('user', mapped.custodianId);
    await upsertRow('fixedAsset', id, { ...mapped, ...timestamps(doc) }, {
      status: mapped.status || 'in_transit',
      netBookValue: mapped.netBookValue,
      accumulatedDepreciation: mapped.accumulatedDepreciation,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncDepreciationEntries() {
  const M = rawModel('DepreciationEntry', 'depreciationentries');
  const docs = await M.find({}).lean();
  console.log(`DepreciationEntries: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('DepreciationEntry', id, 'missing company');
      continue;
    }
    const mapped = depreciationEntryTranslateCreate(doc);
    if (!(await refExists('fixedAsset', mapped.assetId))) {
      logSkip('DepreciationEntry', id, 'missing asset');
      continue;
    }
    if (!(await refExists('journalEntry', mapped.journalEntryId))) {
      logSkip('DepreciationEntry', id, 'missing journalEntry');
      continue;
    }
    if (!mapped.postedById) {
      logSkip('DepreciationEntry', id, 'missing postedBy');
      continue;
    }
    mapped.reversedById = await optionalRef('user', mapped.reversedById);
    await upsertRow('depreciationEntry', id, { ...mapped, ...timestamps(doc) }, {
      isReversed: mapped.isReversed ?? false,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncAssetDisposalEvents() {
  const M = rawModel('AssetDisposalEvent', 'assetdisposalevents');
  const docs = await M.find({}).lean();
  console.log(`AssetDisposalEvents: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('AssetDisposalEvent', id, 'missing company');
      continue;
    }
    const mapped = assetDisposalEventTranslateCreate(doc);
    if (!(await refExists('fixedAsset', mapped.assetId))) {
      logSkip('AssetDisposalEvent', id, 'missing asset');
      continue;
    }
    if (!mapped.processedById) {
      logSkip('AssetDisposalEvent', id, 'missing processedBy');
      continue;
    }
    mapped.disposalJournalEntryId = await optionalRef('journalEntry', mapped.disposalJournalEntryId);
    mapped.tradeInAssetId = await optionalRef('fixedAsset', mapped.tradeInAssetId);
    mapped.soldToCustomerId = await optionalRef('client', mapped.soldToCustomerId);
    mapped.saleInvoiceId = await optionalRef('invoice', mapped.saleInvoiceId);
    mapped.proceedsBankAccountId = await optionalRef('bankAccount', mapped.proceedsBankAccountId);
    mapped.reversedById = await optionalRef('user', mapped.reversedById);
    await upsertRow('assetDisposalEvent', id, mapped, {
      isReversed: mapped.isReversed ?? false,
      gainLoss: mapped.gainLoss,
    });
    n += 1;
  }
  return n;
}

async function syncAssetStatusHistories() {
  const M = rawModel('AssetStatusHistory', 'assetstatushistories');
  const docs = await M.find({}).lean();
  console.log(`AssetStatusHistories: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('AssetStatusHistory', id, 'missing company');
      continue;
    }
    const mapped = assetStatusHistoryTranslateCreate(doc);
    if (!(await refExists('fixedAsset', mapped.assetId))) {
      logSkip('AssetStatusHistory', id, 'missing asset');
      continue;
    }
    if (!mapped.changedById) {
      logSkip('AssetStatusHistory', id, 'missing changedBy');
      continue;
    }
    mapped.custodianIdAtChange = await optionalRef('user', mapped.custodianIdAtChange);
    await upsertRow('assetStatusHistory', id, { ...mapped, companyId }, {
      toStatus: mapped.toStatus,
      reason: mapped.reason ?? null,
    });
    n += 1;
  }
  return n;
}

async function syncFixedAssetDisposalLinks() {
  const M = rawModel('FixedAssetDisposalLink', 'fixedassets');
  const docs = await M.find({ disposalEvent: { $exists: true, $ne: null } }).lean();
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const disposalEventId = await optionalRef('assetDisposalEvent', oid(doc.disposalEvent || doc.disposalEventId));
    if (!disposalEventId) continue;
    await prisma.fixedAsset.updateMany({
      where: { id },
      data: { disposalEventId },
    });
    n += 1;
  }
  return n;
}

async function syncEmployees() {
  const M = rawModel('Employee', 'employees');
  const docs = await M.find({}).lean();
  console.log(`Employees: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('Employee', id, 'missing company');
      continue;
    }
    const mapped = employeeTranslateCreate(doc);
    mapped.managerId = await optionalRef('employee', mapped.managerId);
    mapped.updatedById = await optionalRef('user', mapped.updatedById);
    await upsertRow('employee', id, { ...mapped, ...timestamps(doc) }, {
      status: mapped.status || 'active',
      currentSalary: mapped.currentSalary ?? null,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncSalaryHistories() {
  const M = rawModel('SalaryHistory', 'salaryhistories');
  const docs = await M.find({}).lean();
  console.log(`SalaryHistories: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('SalaryHistory', id, 'missing company');
      continue;
    }
    const mapped = salaryHistoryTranslateCreate(doc);
    if (!(await refExists('employee', mapped.employeeId))) {
      logSkip('SalaryHistory', id, 'missing employee');
      continue;
    }
    mapped.changedById = await optionalRef('user', mapped.changedById);
    await upsertRow('salaryHistory', id, { ...mapped, ...timestamps(doc) }, {
      endDate: mapped.endDate ?? null,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncPayrollRuns() {
  const M = rawModel('PayrollRun', 'payrollruns');
  const docs = await M.find({}).lean();
  console.log(`PayrollRuns: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('PayrollRun', id, 'missing company');
      continue;
    }
    const mapped = payrollRunTranslateCreate(doc);
    if (!(await refExists('bankAccount', mapped.bankAccountId))) {
      logSkip('PayrollRun', id, 'missing bankAccount');
      continue;
    }
    mapped.journalEntryId = await optionalRef('journalEntry', mapped.journalEntryId);
    mapped.reversalJournalEntryId = await optionalRef('journalEntry', mapped.reversalJournalEntryId);
    mapped.netPayJournalId = await optionalRef('journalEntry', mapped.netPayJournalId);
    mapped.payeRemitJournalId = await optionalRef('journalEntry', mapped.payeRemitJournalId);
    mapped.rssbRemitJournalId = await optionalRef('journalEntry', mapped.rssbRemitJournalId);
    mapped.postedById = await optionalRef('user', mapped.postedById);
    await upsertRow('payrollRun', id, { ...mapped, ...timestamps(doc) }, {
      status: mapped.status || 'draft',
      totalNet: mapped.totalNet,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncPayrolls() {
  const M = rawModel('Payroll', 'payrolls');
  const docs = await M.find({}).lean();
  console.log(`Payrolls: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('Payroll', id, 'missing company');
      continue;
    }
    const mapped = payrollTranslateCreate(doc);
    if (mapped.employeeRefId && !(await refExists('employee', mapped.employeeRefId))) {
      mapped.employeeRefId = null;
    }
    mapped.payrollRunId = await optionalRef('payrollRun', mapped.payrollRunId);
    mapped.approvedById = await optionalRef('user', mapped.approvedById);
    await upsertRow('payroll', id, { ...mapped, ...timestamps(doc) }, {
      recordStatus: mapped.recordStatus || 'draft',
      netPay: mapped.netPay,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncTimesheets() {
  const M = rawModel('Timesheet', 'timesheets');
  const docs = await M.find({}).lean();
  console.log(`Timesheets: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('Timesheet', id, 'missing company');
      continue;
    }
    const mapped = timesheetTranslateCreate(doc);
    if (!(await refExists('employee', mapped.employeeId))) {
      logSkip('Timesheet', id, 'missing employee');
      continue;
    }
    mapped.approvedById = await optionalRef('user', mapped.approvedById);
    mapped.updatedById = await optionalRef('user', mapped.updatedById);
    await upsertRow('timesheet', id, { ...mapped, ...timestamps(doc) }, {
      status: mapped.status || 'draft',
      totalHours: mapped.totalHours,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncEmployeeAdvances() {
  const M = rawModel('EmployeeAdvance', 'employeeadvances');
  const docs = await M.find({}).lean();
  console.log(`EmployeeAdvances: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('EmployeeAdvance', id, 'missing company');
      continue;
    }
    const mapped = employeeAdvanceTranslateCreate(doc);
    if (!(await refExists('employee', mapped.employeeId))) {
      logSkip('EmployeeAdvance', id, 'missing employee');
      continue;
    }
    if (!mapped.createdById) {
      logSkip('EmployeeAdvance', id, 'missing createdBy');
      continue;
    }
    mapped.bankAccountId = await optionalRef('bankAccount', mapped.bankAccountId);
    mapped.journalEntryId = await optionalRef('journalEntry', mapped.journalEntryId);
    mapped.updatedById = await optionalRef('user', mapped.updatedById);
    await upsertRow('employeeAdvance', id, { ...mapped, ...timestamps(doc) }, {
      status: mapped.status || 'issued',
      balance: mapped.balance,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncProjects() {
  const M = rawModel('Project', 'projects');
  const docs = await M.find({}).lean();
  console.log(`Projects: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('Project', id, 'missing company');
      continue;
    }
    const mapped = projectTranslateCreate(doc);
    mapped.parentId = await optionalRef('project', mapped.parentId);
    mapped.clientId = await optionalRef('client', mapped.clientId);
    mapped.managerId = await optionalRef('user', mapped.managerId);
    await upsertRow('project', id, { ...mapped, ...timestamps(doc) }, {
      status: mapped.status || 'planning',
      budgetSpent: mapped.budgetSpent,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncBudgets() {
  const M = rawModel('Budget', 'budgets');
  const docs = await M.find({}).lean();
  console.log(`Budgets: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('Budget', id, 'missing company');
      continue;
    }
    const mapped = budgetTranslateCreate(doc);
    if (!mapped.createdById) {
      logSkip('Budget', id, 'missing createdBy');
      continue;
    }
    mapped.workflowId = await optionalRef('budgetWorkflowConfig', mapped.workflowId);
    mapped.entityId = await optionalRef('company', mapped.entityId);
    mapped.parentBudgetId = await optionalRef('budget', mapped.parentBudgetId);
    mapped.approvedById = await optionalRef('user', mapped.approvedById);
    mapped.lockedById = await optionalRef('user', mapped.lockedById);
    mapped.unlockedById = await optionalRef('user', mapped.unlockedById);
    mapped.rejectedById = await optionalRef('user', mapped.rejectedById);
    mapped.closedById = await optionalRef('user', mapped.closedById);
    mapped.ownerId = await optionalRef('user', mapped.ownerId);
    await upsertRow('budget', id, { ...mapped, ...timestamps(doc) }, {
      status: mapped.status || 'draft',
      amount: mapped.amount,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncBudgetLines() {
  const M = rawModel('BudgetLine', 'budgetlines');
  const docs = await M.find({}).lean();
  console.log(`BudgetLines: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('BudgetLine', id, 'missing company');
      continue;
    }
    const mapped = budgetLineTranslateCreate(doc);
    if (!(await refExists('budget', mapped.budgetId))) {
      logSkip('BudgetLine', id, 'missing budget');
      continue;
    }
    mapped.projectId = await optionalRef('project', mapped.projectId);
    await upsertRow('budgetLine', id, { ...mapped, ...timestamps(doc) }, {
      budgetedAmount: mapped.budgetedAmount,
      actualAmount: mapped.actualAmount,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncBudgetWorkflowConfigs() {
  const M = rawModel('BudgetWorkflowConfig', 'budgetworkflowconfigs');
  const docs = await M.find({}).lean();
  console.log(`BudgetWorkflowConfigs: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('BudgetWorkflowConfig', id, 'missing company');
      continue;
    }
    const mapped = budgetWorkflowConfigTranslateCreate(doc);
    if (!mapped.createdById) {
      logSkip('BudgetWorkflowConfig', id, 'missing createdBy');
      continue;
    }
    mapped.updatedById = await optionalRef('user', mapped.updatedById);
    await upsertRow('budgetWorkflowConfig', id, { ...mapped, ...timestamps(doc) }, {
      isActive: mapped.isActive ?? true,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncBudgetActualConsumptions() {
  const M = rawModel('BudgetActualConsumption', 'budgetactualconsumptions');
  const docs = await M.find({}).lean();
  console.log(`BudgetActualConsumptions: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('BudgetActualConsumption', id, 'missing company');
      continue;
    }
    const mapped = budgetActualConsumptionTranslateCreate(doc);
    if (!(await refExists('budget', mapped.budgetId))) {
      logSkip('BudgetActualConsumption', id, 'missing budget');
      continue;
    }
    if (!(await refExists('budgetLine', mapped.budgetLineId))) {
      logSkip('BudgetActualConsumption', id, 'missing budgetLine');
      continue;
    }
    mapped.projectId = await optionalRef('project', mapped.projectId);
    mapped.createdById = await optionalRef('user', mapped.createdById);
    await upsertRow('budgetActualConsumption', id, { ...mapped, ...timestamps(doc) }, {
      amount: mapped.amount,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncBudgetTransfers() {
  const M = rawModel('BudgetTransfer', 'budgettransfers');
  const docs = await M.find({}).lean();
  console.log(`BudgetTransfers: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('BudgetTransfer', id, 'missing company');
      continue;
    }
    const mapped = budgetTransferTranslateCreate(doc);
    if (!(await refExists('budget', mapped.budgetId))) {
      logSkip('BudgetTransfer', id, 'missing budget');
      continue;
    }
    if (!(await refExists('budgetLine', mapped.fromLineId)) || !(await refExists('budgetLine', mapped.toLineId))) {
      logSkip('BudgetTransfer', id, 'missing budgetLine');
      continue;
    }
    if (!mapped.requestedById) {
      logSkip('BudgetTransfer', id, 'missing requestedBy');
      continue;
    }
    mapped.approvedById = await optionalRef('user', mapped.approvedById);
    mapped.rejectedById = await optionalRef('user', mapped.rejectedById);
    mapped.executedById = await optionalRef('user', mapped.executedById);
    mapped.cancelledById = await optionalRef('user', mapped.cancelledById);
    await upsertRow('budgetTransfer', id, { ...mapped, ...timestamps(doc) }, {
      status: mapped.status || 'pending',
      amount: mapped.amount,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncBudgetRevisions() {
  const M = rawModel('BudgetRevision', 'budgetrevisions');
  const docs = await M.find({}).lean();
  console.log(`BudgetRevisions: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('BudgetRevision', id, 'missing company');
      continue;
    }
    const mapped = budgetRevisionTranslateCreate(doc);
    if (!(await refExists('budget', mapped.budgetId))) {
      logSkip('BudgetRevision', id, 'missing budget');
      continue;
    }
    if (!mapped.changedById) {
      logSkip('BudgetRevision', id, 'missing changedBy');
      continue;
    }
    mapped.affectedLineId = await optionalRef('budgetLine', mapped.affectedLineId);
    mapped.rolledBackById = await optionalRef('user', mapped.rolledBackById);
    await upsertRow('budgetRevision', id, { ...mapped, ...timestamps(doc) }, {
      rolledBack: mapped.rolledBack ?? false,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncBudgetPeriodLocks() {
  const M = rawModel('BudgetPeriodLock', 'budgetperiodlocks');
  const docs = await M.find({}).lean();
  console.log(`BudgetPeriodLocks: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('BudgetPeriodLock', id, 'missing company');
      continue;
    }
    const mapped = budgetPeriodLockTranslateCreate(doc);
    if (!(await refExists('budget', mapped.budgetId))) {
      logSkip('BudgetPeriodLock', id, 'missing budget');
      continue;
    }
    mapped.createdById = await optionalRef('user', mapped.createdById);
    mapped.updatedById = await optionalRef('user', mapped.updatedById);
    await upsertRow('budgetPeriodLock', id, { ...mapped, ...timestamps(doc) }, {
      lockedPeriods: mapped.lockedPeriods ?? [],
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncBudgetApprovals() {
  const M = rawModel('BudgetApproval', 'budgetapprovals');
  const docs = await M.find({}).lean();
  console.log(`BudgetApprovals: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('BudgetApproval', id, 'missing company');
      continue;
    }
    const mapped = budgetApprovalTranslateCreate(doc);
    if (!(await refExists('budget', mapped.budgetId))) {
      logSkip('BudgetApproval', id, 'missing budget');
      continue;
    }
    if (!mapped.requestedById) {
      logSkip('BudgetApproval', id, 'missing requestedBy');
      continue;
    }
    mapped.workflowId = await optionalRef('budgetWorkflowConfig', mapped.workflowId);
    mapped.finalApprovedById = await optionalRef('user', mapped.finalApprovedById);
    mapped.rejectedById = await optionalRef('user', mapped.rejectedById);
    mapped.changesRequestedById = await optionalRef('user', mapped.changesRequestedById);
    mapped.cancelledById = await optionalRef('user', mapped.cancelledById);
    await upsertRow('budgetApproval', id, { ...mapped, ...timestamps(doc) }, {
      status: mapped.status || 'pending',
      currentStep: mapped.currentStep,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncBudgetAlerts() {
  const M = rawModel('BudgetAlert', 'budgetalerts');
  const docs = await M.find({}).lean();
  console.log(`BudgetAlerts: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('BudgetAlert', id, 'missing company');
      continue;
    }
    const mapped = budgetAlertTranslateCreate(doc);
    mapped.budgetId = await optionalRef('budget', mapped.budgetId);
    mapped.createdById = await optionalRef('user', mapped.createdById);
    mapped.updatedById = await optionalRef('user', mapped.updatedById);
    await upsertRow('budgetAlert', id, { ...mapped, ...timestamps(doc) }, {
      isEnabled: mapped.isEnabled ?? true,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncEncumbrances() {
  const M = rawModel('Encumbrance', 'encumbrances');
  const docs = await M.find({}).lean();
  console.log(`Encumbrances: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('Encumbrance', id, 'missing company');
      continue;
    }
    const mapped = encumbranceTranslateCreate(doc);
    if (!(await refExists('budget', mapped.budgetId))) {
      logSkip('Encumbrance', id, 'missing budget');
      continue;
    }
    if (!(await refExists('budgetLine', mapped.budgetLineId))) {
      logSkip('Encumbrance', id, 'missing budgetLine');
      continue;
    }
    if (!mapped.createdById) {
      logSkip('Encumbrance', id, 'missing createdBy');
      continue;
    }
    mapped.releasedById = await optionalRef('user', mapped.releasedById);
    await upsertRow('encumbrance', id, { ...mapped, ...timestamps(doc) }, {
      status: mapped.status || 'active',
      remainingAmount: mapped.remainingAmount,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncEbmDevices() {
  const M = rawModel('EbmDevice', 'ebmdevices');
  const docs = await M.find({}).lean();
  console.log(`EbmDevices: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('EbmDevice', id, 'missing company');
      continue;
    }
    const mapped = ebmDeviceTranslateCreate(doc);
    mapped.updatedById = await optionalRef('user', mapped.updatedById);
    await upsertRow('ebmDevice', id, { ...mapped, ...timestamps(doc) }, {
      status: mapped.status || 'not_initialized',
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncEbmCodes() {
  const M = rawModel('EbmCode', 'ebmcodes');
  const docs = await M.find({}).lean();
  console.log(`EbmCodes: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('EbmCode', id, 'missing company');
      continue;
    }
    const mapped = ebmCodeTranslateCreate(doc);
    await upsertRow('ebmCode', id, { ...mapped, ...timestamps(doc) }, {
      active: mapped.active ?? true,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncEbmItemClasses() {
  const M = rawModel('EbmItemClass', 'ebmitemclasses');
  const docs = await M.find({}).lean();
  console.log(`EbmItemClasses: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('EbmItemClass', id, 'missing company');
      continue;
    }
    const mapped = ebmItemClassTranslateCreate(doc);
    await upsertRow('ebmItemClass', id, { ...mapped, ...timestamps(doc) }, {
      active: mapped.active ?? true,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncEbmTins() {
  const M = rawModel('EbmTin', 'ebmtins');
  const docs = await M.find({}).lean();
  console.log(`EbmTins: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const mapped = ebmTinTranslateCreate(doc);
    await upsertRow('ebmTin', id, { ...mapped, ...timestamps(doc) }, {
      active: mapped.active ?? true,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncEbmNotices() {
  const M = rawModel('EbmNotice', 'ebmnotices');
  const docs = await M.find({}).lean();
  console.log(`EbmNotices: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('EbmNotice', id, 'missing company');
      continue;
    }
    const mapped = ebmNoticeTranslateCreate(doc);
    await upsertRow('ebmNotice', id, { ...mapped, ...timestamps(doc) }, {
      active: mapped.active ?? true,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncEbmImportedItems() {
  const M = rawModel('EbmImportedItem', 'ebmimporteditems');
  const docs = await M.find({}).lean();
  console.log(`EbmImportedItems: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('EbmImportedItem', id, 'missing company');
      continue;
    }
    const mapped = ebmImportedItemTranslateCreate(doc);
    mapped.confirmedById = await optionalRef('user', mapped.confirmedById);
    mapped.rejectedById = await optionalRef('user', mapped.rejectedById);
    mapped.productId = await optionalRef('product', mapped.productId);
    mapped.warehouseId = await optionalRef('warehouse', mapped.warehouseId);
    mapped.supplierId = await optionalRef('supplier', mapped.supplierId);
    mapped.purchaseOrderId = await optionalRef('purchaseOrder', mapped.purchaseOrderId);
    mapped.grnId = await optionalRef('goodsReceivedNote', mapped.grnId);
    await upsertRow('ebmImportedItem', id, { ...mapped, ...timestamps(doc) }, {
      confirmationStatus: mapped.confirmationStatus || 'pending',
      stockUpdated: mapped.stockUpdated ?? false,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncEbmUnmatchedPurchases() {
  const M = rawModel('EbmUnmatchedPurchase', 'ebmunmatchedpurchases');
  const docs = await M.find({}).lean();
  console.log(`EbmUnmatchedPurchases: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('EbmUnmatchedPurchase', id, 'missing company');
      continue;
    }
    const mapped = ebmUnmatchedPurchaseTranslateCreate(doc);
    mapped.reviewedById = await optionalRef('user', mapped.reviewedById);
    await upsertRow('ebmUnmatchedPurchase', id, { ...mapped, ...timestamps(doc) }, {
      status: mapped.status || 'unmatched',
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncEbmSubmissionQueues() {
  const M = rawModel('EbmSubmissionQueue', 'ebmsubmissionqueues');
  const docs = await M.find({}).lean();
  console.log(`EbmSubmissionQueues: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('EbmSubmissionQueue', id, 'missing company');
      continue;
    }
    const mapped = ebmSubmissionQueueTranslateCreate(doc);
    await upsertRow('ebmSubmissionQueue', id, { ...mapped, ...timestamps(doc) }, {
      ebmStatus: mapped.ebmStatus || 'pending',
      retryCount: mapped.retryCount ?? 0,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncEbmAlerts() {
  const M = rawModel('EbmAlert', 'ebmalerts');
  const docs = await M.find({}).lean();
  console.log(`EbmAlerts: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('EbmAlert', id, 'missing company');
      continue;
    }
    const mapped = ebmAlertTranslateCreate(doc);
    if (!(await refExists('ebmSubmissionQueue', mapped.queueId))) {
      logSkip('EbmAlert', id, 'missing queue');
      continue;
    }
    mapped.acknowledgedById = await optionalRef('user', mapped.acknowledgedById);
    mapped.resetById = await optionalRef('user', mapped.resetById);
    await upsertRow('ebmAlert', id, { ...mapped, ...timestamps(doc) }, {
      status: mapped.status || 'open',
      acknowledged: mapped.acknowledged ?? false,
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function syncEbmSyncStates() {
  const M = rawModel('EbmSyncState', 'ebmsyncstates');
  const docs = await M.find({}).lean();
  console.log(`EbmSyncStates: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = resolveCompanyId(doc);
    if (!(await companyExists(companyId))) {
      logSkip('EbmSyncState', id, 'missing company');
      continue;
    }
    const mapped = ebmSyncStateTranslateCreate(doc);
    await upsertRow('ebmSyncState', id, { ...mapped, ...timestamps(doc) }, {
      lastReqDt: mapped.lastReqDt,
      mode: mapped.mode || 'mock',
      updatedAt: doc.updatedAt || new Date(),
    });
    n += 1;
  }
  return n;
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI required');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  await connectPrisma();
  console.log(DRY_RUN ? 'DRY RUN' : 'SYNC');
  const results = {
    assetCategories: await syncAssetCategories(),
    fixedAssets: await syncFixedAssets(),
    depreciationEntries: await syncDepreciationEntries(),
    assetDisposalEvents: await syncAssetDisposalEvents(),
    assetStatusHistories: await syncAssetStatusHistories(),
    fixedAssetDisposalLinks: await syncFixedAssetDisposalLinks(),
    employees: await syncEmployees(),
    salaryHistories: await syncSalaryHistories(),
    payrollRuns: await syncPayrollRuns(),
    payrolls: await syncPayrolls(),
    timesheets: await syncTimesheets(),
    employeeAdvances: await syncEmployeeAdvances(),
    projects: await syncProjects(),
    budgets: await syncBudgets(),
    budgetLines: await syncBudgetLines(),
    budgetWorkflowConfigs: await syncBudgetWorkflowConfigs(),
    budgetActualConsumptions: await syncBudgetActualConsumptions(),
    budgetTransfers: await syncBudgetTransfers(),
    budgetRevisions: await syncBudgetRevisions(),
    budgetPeriodLocks: await syncBudgetPeriodLocks(),
    budgetApprovals: await syncBudgetApprovals(),
    budgetAlerts: await syncBudgetAlerts(),
    encumbrances: await syncEncumbrances(),
    ebmDevices: await syncEbmDevices(),
    ebmCodes: await syncEbmCodes(),
    ebmItemClasses: await syncEbmItemClasses(),
    ebmTins: await syncEbmTins(),
    ebmNotices: await syncEbmNotices(),
    ebmImportedItems: await syncEbmImportedItems(),
    ebmUnmatchedPurchases: await syncEbmUnmatchedPurchases(),
    ebmSubmissionQueues: await syncEbmSubmissionQueues(),
    ebmAlerts: await syncEbmAlerts(),
    ebmSyncStates: await syncEbmSyncStates(),
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
