const cron = require('node-cron');
const RecurringInvoice = require('../models/RecurringInvoice');
const RecurringInvoiceRun = require('../models/RecurringInvoiceRun');
const Invoice = require('../models/Invoice');
const { confirmDraftInvoice } = require('./invoiceAutoConfirmService');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CATCH_UP_RUNS_PER_TEMPLATE = 12;

function utcStartOfDay(value) {
  const date = new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function daysInUtcMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Return the next scheduled occurrence strictly after `fromDate`. */
function computeNextRunDate(schedule = {}, fromDate = Date.now()) {
  const from = utcStartOfDay(fromDate);
  const frequency = String(schedule.frequency || '').toLowerCase();
  const interval = Number(schedule.interval ?? 1);
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) {
    throw new Error('Schedule interval must be a whole number between 1 and 365.');
  }

  if (frequency === 'daily') return new Date(from.getTime() + interval * DAY_MS);
  if (frequency === 'weekly') {
    const weekday = Number.isInteger(schedule.dayOfWeek) && schedule.dayOfWeek >= 0 && schedule.dayOfWeek <= 6
      ? schedule.dayOfWeek
      : from.getUTCDay();
    const weekStart = new Date(from);
    weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
    const candidate = new Date(weekStart);
    candidate.setUTCDate(candidate.getUTCDate() + weekday + 7 * (interval - 1));
    if (candidate <= from) candidate.setUTCDate(candidate.getUTCDate() + 7 * interval);
    return candidate;
  }
  if (frequency === 'monthly' || frequency === 'quarterly') {
    const step = interval * (frequency === 'quarterly' ? 3 : 1);
    const day = Number.isInteger(schedule.dayOfMonth) && schedule.dayOfMonth >= 1 && schedule.dayOfMonth <= 31
      ? schedule.dayOfMonth
      : from.getUTCDate();
    const targetMonth = from.getUTCMonth() + step;
    const year = from.getUTCFullYear() + Math.floor(targetMonth / 12);
    const month = targetMonth % 12;
    return new Date(Date.UTC(year, month, Math.min(day, daysInUtcMonth(year, month))));
  }
  if (frequency === 'annually') {
    const year = from.getUTCFullYear() + interval;
    const month = from.getUTCMonth();
    return new Date(Date.UTC(year, month, Math.min(from.getUTCDate(), daysInUtcMonth(year, month))));
  }
  throw new Error('Schedule frequency must be daily, weekly, monthly, quarterly, or annually.');
}

async function checkIdempotency(templateId, runDate, companyId) {
  const query = {
    recurringInvoice: templateId,
    runDate: utcStartOfDay(runDate),
  };
  if (companyId) query.company = companyId;
  return RecurringInvoiceRun.findOne(query);
}

function isUniqueConflict(error) {
  return error?.code === 'P2002' || error?.code === 11000;
}

async function claimRun(template, runDate) {
  try {
    return {
      run: await RecurringInvoiceRun.create({
        recurringInvoice: template._id,
        company: template.company,
        runDate,
        status: 'processing',
      }),
      claimed: true,
    };
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
  }

  let existing = await checkIdempotency(template._id, runDate, template.company);
  if (!existing) throw new Error('Recurring invoice run conflict could not be resolved.');

  // Recover abandoned jobs after a process restart. Only one worker can change
  // the run from processing to failed and then claim it again.
  if (existing.status === 'processing'
      && new Date(existing.updatedAt || existing.createdAt).getTime() < Date.now() - 15 * 60 * 1000) {
    await RecurringInvoiceRun.updateMany(
      { _id: existing._id, status: 'processing', updatedAt: { $lt: new Date(Date.now() - 15 * 60 * 1000) } },
      { status: 'failed', errorMessage: 'Previous worker stopped before completing this invoice run.' },
    );
    existing = await checkIdempotency(template._id, runDate, template.company);
  }

  if (existing?.status === 'failed') {
    const claimed = await RecurringInvoiceRun.findOneAndUpdate(
      { _id: existing._id, status: 'failed' },
      { status: 'processing', errorMessage: null },
      { new: true },
    );
    if (claimed) return { run: claimed, claimed: true, existingInvoiceId: existing.invoice };
  }

  return { run: existing, claimed: false, existingInvoiceId: existing.invoice };
}

async function alertFinanceTeam(companyId, template, message) {
  try {
    const { notifyRecurringFailed } = require('./notificationHelper');
    await notifyRecurringFailed(companyId, template, message);
  } catch (error) {
    console.error('Failed to send recurring invoice alert:', error);
  }
}

function buildInvoiceData(template, runDate) {
  const dueDays = Number(template.schedule?.dueDays ?? 30);
  const dueDate = new Date(runDate.getTime() + dueDays * DAY_MS);
  return {
    company: template.company,
    client: template.client,
    lines: template.lines.map((line) => ({
      product: line.product,
      description: line.description || line.productName,
      productName: line.productName,
      productCode: line.productCode,
      itemCode: line.productCode,
      qty: line.qty,
      quantity: line.qty,
      unit: line.unit,
      unitPrice: line.unitPrice,
      discountPct: line.discountPct || 0,
      discount: line.discountPct || 0,
      taxCode: line.taxCode || 'A',
      taxRate: line.taxRate || 0,
      warehouse: line.warehouse,
    })),
    currencyCode: template.currencyCode || 'RWF',
    currency: template.currencyCode || 'RWF',
    createdBy: template.createdBy,
    status: 'draft',
    generatedFromRecurring: template._id,
    invoiceDate: runDate,
    dueDate,
    terms: `${dueDays} days`,
  };
}

function canAutoConfirmTemplate(template) {
  return !(template.lines || []).some((line) => {
    const product = line.product;
    return product
      && typeof product === 'object'
      && product.isStockable !== false
      && product.trackingType
      && product.trackingType !== 'none';
  });
}

async function advanceSchedule(template, occurrence, now) {
  let next = computeNextRunDate(template.schedule, occurrence);
  const changes = {
    nextRunDate: next,
    lastRunAt: now,
  };
  if (template.endDate && next > utcStartOfDay(template.endDate)) {
    changes.status = 'completed';
  }
  await RecurringInvoice.findOneAndUpdate(
    { _id: template._id, company: template.company, nextRunDate: template.nextRunDate },
    changes,
    { new: true },
  );
  return next;
}

/**
 * Generate a single invoice for the next scheduled date or an explicit manual
 * run. A unique run row is claimed before creating an invoice, so duplicate
 * scheduler processes cannot emit duplicate invoices for the same occurrence.
 */
async function generateForTemplate(templateId, { companyId, scheduled = false } = {}) {
  const query = { _id: templateId };
  if (companyId) query.company = companyId;
  const template = await RecurringInvoice.findOne(query).populate('lines.product');
  if (!template || template.status !== 'active') throw new Error('Recurring invoice not found or not active.');

  const now = new Date();
  const today = utcStartOfDay(now);
  const occurrence = scheduled
    ? utcStartOfDay(template.nextRunDate || template.startDate)
    : today;
  if (scheduled && occurrence > today) return null;
  if (template.startDate && occurrence < utcStartOfDay(template.startDate)) {
    if (scheduled) {
      await RecurringInvoice.findOneAndUpdate(
        { _id: template._id, company: template.company, nextRunDate: template.nextRunDate },
        { nextRunDate: utcStartOfDay(template.startDate) },
        { new: true },
      );
    }
    return null;
  }
  if (template.endDate && occurrence > utcStartOfDay(template.endDate)) {
    await RecurringInvoice.findOneAndUpdate(
      { _id: template._id, company: template.company, status: 'active' },
      { status: 'completed' },
      { new: true },
    );
    return null;
  }

  const { run, claimed, existingInvoiceId } = await claimRun(template, occurrence);
  if (!claimed) {
    if (scheduled && run?.status === 'success') await advanceSchedule(template, occurrence, now);
    return run?.invoice ? Invoice.findOne({ _id: run.invoice, company: template.company }) : null;
  }

  let invoice = null;
  try {
    if (existingInvoiceId) {
      invoice = await Invoice.findOne({ _id: existingInvoiceId, company: template.company });
    }
    // A worker can stop after invoice creation but before attaching its ID to
    // the run row. Recover the already-created invoice instead of duplicating it.
    if (!invoice) {
      invoice = await Invoice.findOne({
        generatedFromRecurring: template._id,
        company: template.company,
        invoiceDate: occurrence,
      });
    }
    if (!invoice) invoice = await Invoice.create(buildInvoiceData(template, occurrence));

    if (template.autoConfirm && canAutoConfirmTemplate(template) && invoice.status === 'draft') {
      invoice = await confirmDraftInvoice(template.company, invoice._id, template.createdBy);
      if (invoice?.status !== 'confirmed') {
        throw new Error('The generated invoice could not be confirmed. It remains a draft for review.');
      }
    }

    await RecurringInvoiceRun.findOneAndUpdate(
      { _id: run._id, status: 'processing' },
      { invoice: invoice._id, status: 'success', errorMessage: null },
      { new: true },
    );
    if (scheduled) await advanceSchedule(template, occurrence, now);
    return invoice;
  } catch (error) {
    const message = error?.message || 'Recurring invoice generation failed.';
    await RecurringInvoiceRun.findOneAndUpdate(
      { _id: run._id, status: 'processing' },
      { invoice: invoice?._id || existingInvoiceId || null, status: 'failed', errorMessage: message },
      { new: true },
    );
    await alertFinanceTeam(template.company, template, message);
    throw error;
  }
}

async function generateDueRecurringInvoices({ companyId } = {}) {
  const now = new Date();
  const today = utcStartOfDay(now);
  const query = {
    status: 'active',
    startDate: { $lte: now },
    nextRunDate: { $lte: today },
  };
  if (companyId) query.company = companyId;
  const due = await RecurringInvoice.find(query);

  for (const template of due) {
    for (let count = 0; count < MAX_CATCH_UP_RUNS_PER_TEMPLATE; count += 1) {
      const fresh = await RecurringInvoice.findOne({ _id: template._id, company: template.company });
      if (!fresh || fresh.status !== 'active' || !fresh.nextRunDate || utcStartOfDay(fresh.nextRunDate) > today) break;
      try {
        await generateForTemplate(fresh._id, { companyId: fresh.company, scheduled: true });
      } catch (error) {
        console.error('Recurring invoice generation failed:', fresh.referenceNo, error.message);
        break;
      }
    }
  }
  return { completed: true, dueTemplates: due.length };
}

let task = null;
let schedulerConfig = { cronExpression: '1 0 * * *', enabled: true };

function configureScheduler(cronExpression) {
  if (cronExpression) schedulerConfig.cronExpression = cronExpression;
}

function startScheduler() {
  if (task || !schedulerConfig.enabled) return;
  task = cron.schedule(schedulerConfig.cronExpression, () => {
    generateDueRecurringInvoices().catch((error) => console.error('Recurring scheduler failed:', error));
  }, { scheduled: true, timezone: 'UTC' });
  generateDueRecurringInvoices().catch((error) => console.error('Recurring startup run failed:', error));
}

function stopScheduler() {
  if (task) {
    task.stop();
    task = null;
  }
}

module.exports = {
  startScheduler,
  stopScheduler,
  configureScheduler,
  generateDueRecurringInvoices,
  generateForTemplate,
  computeNextRunDate,
  checkIdempotency,
  canAutoConfirmTemplate,
};
