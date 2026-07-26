const cron = require('node-cron');
const RecurringInvoice = require('../models/RecurringInvoice');
const RecurringInvoiceRun = require('../models/RecurringInvoiceRun');
const Invoice = require('../models/Invoice');
const { confirmDraftInvoice } = require('./invoiceAutoConfirmService');

function addMonthsSafe(date, months) {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) {
    d.setDate(0);
  }
  return d;
}

function addYearsSafe(date, years) {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + years);
  return d;
}

function addDaysSafe(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function getStartOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function computeNextRunDate(schedule, fromDate) {
  const now = new Date(fromDate || Date.now());
  const freq = schedule.frequency;
  const interval = schedule.interval || 1;

  if (freq === 'daily') {
    return addDaysSafe(now, interval);
  }

  if (freq === 'weekly') {
    const dayOfWeek = (typeof schedule.dayOfWeek === 'number') ? schedule.dayOfWeek : now.getDay();
    const base = new Date(now);
    base.setHours(0, 0, 0, 0);
    const delta = (dayOfWeek - base.getDay() + 7) % 7;
    base.setDate(base.getDate() + delta);
    if (base <= now) base.setDate(base.getDate() + (7 * interval));
    return base;
  }

  if (freq === 'monthly' || freq === 'quarterly') {
    const monthsToAdd = freq === 'quarterly' ? 3 * interval : interval;
    const dayOfMonth = schedule.dayOfMonth || now.getDate();
    let candidate = addMonthsSafe(now, monthsToAdd);
    candidate.setDate(Math.min(dayOfMonth, 28));
    if (candidate <= now) candidate = addMonthsSafe(candidate, monthsToAdd);
    return candidate;
  }

  if (freq === 'annually') {
    const candidate = addYearsSafe(now, interval);
    if (candidate <= now) candidate = addYearsSafe(candidate, interval);
    return candidate;
  }

  return addDaysSafe(now, 1);
}

/**
 * Check if a run already exists for this template on this date (idempotency)
 */
async function checkIdempotency(templateId, runDate) {
  const startOfDay = getStartOfDay(runDate);
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);
  
  const existing = await RecurringInvoiceRun.findOne({
    recurringInvoice: templateId,
    runDate: {
      $gte: startOfDay,
      $lt: endOfDay
    }
  });
  
  return existing;
}

/**
 * Send alert to finance team when auto-confirm fails
 */
async function alertFinanceTeam(companyId, template, errorMessage) {
  try {
    const { notifyRecurringFailed } = require('./notificationHelper');
    await notifyRecurringFailed(companyId, template, errorMessage);
  } catch (e) {
    console.error('Failed to send finance team alert:', e);
  }
}

async function generateForTemplate(templateId) {
  const r = await RecurringInvoice.findById(templateId).populate('lines.product');
  if (!r || r.status !== 'active') {
    throw new Error('Template not found or not active');
  }

  // Check if end_date has passed
  if (r.endDate && new Date(r.endDate) < new Date()) {
    r.status = 'completed';
    await r.save();
    throw new Error('Template has ended');
  }

  const now = new Date();
  const runDate = getStartOfDay(now);

  // IDEMPOTENCY CHECK - Skip if already run today
  const existingRun = await checkIdempotency(r._id, runDate);
  if (existingRun) {
    console.log(`Skipping template ${r._id} - already run today`);
    return null;
  }

  // Create the invoice from template
  const invoiceData = {
    company: r.company,
    client: r.client,
    lines: r.lines.map(i => ({
      product: i.product,
      description: i.description || i.productName,
      productName: i.productName,
      productCode: i.productCode,
      itemCode: i.productCode,
      qty: i.qty || i.quantity,
      quantity: i.qty || i.quantity,
      unit: i.unit,
      unitPrice: i.unitPrice,
      discountPct: i.discountPct || i.discount || 0,
      discount: i.discountPct || i.discount || 0,
      taxCode: i.taxCode || 'A',
      taxRate: i.taxRate || 0,
      warehouse: i.warehouse
    })),
    currencyCode: r.currencyCode || 'USD',
    currency: r.currencyCode || 'USD',
    createdBy: r.createdBy,
    status: 'draft',
    generatedFromRecurring: r._id,
    invoiceDate: runDate,
    dueDate: new Date(runDate.getTime() + 30 * 24 * 60 * 60 * 1000), // 30 days
    terms: '30 days',
  };

  let created = null;
  let runStatus = 'success';
  let errorMessage = null;

  try {
    created = await Invoice.create(invoiceData);

    if (r.autoConfirm) {
      try {
        created = await confirmDraftInvoice(
          r.company,
          created._id,
          r.createdBy,
        );
      } catch (confirmErr) {
        runStatus = 'failed';
        const code = confirmErr.code || '';
        errorMessage = code === 'ERR_INSUFFICIENT_STOCK'
          ? `INSUFFICIENT_STOCK: ${confirmErr.message}`
          : `Auto-confirm failed: ${confirmErr.message}`;
        console.error('Recurring invoice auto-confirm failed:', confirmErr.message);
        await alertFinanceTeam(r.company, r, errorMessage);
        created = await Invoice.findById(created._id);
      }
    }

    // Update next run date
    const next = computeNextRunDate(r.schedule, r.nextRunDate || r.startDate || now);
    
    // Check if next run would exceed end_date
    if (r.endDate && next > new Date(r.endDate)) {
      r.status = 'completed';
    } else {
      r.nextRunDate = next;
    }
    
    r.lastRunAt = now;
    await r.save();

  } catch (errInner) {
    runStatus = 'failed';
    errorMessage = errInner.message;
    console.error('Error creating recurring invoice for template', r._id, errInner);
  }

  // Log the run
  try {
    await RecurringInvoiceRun.create({
      recurringInvoice: r._id,
      company: r.company,
      runDate: runDate,
      invoice: created ? created._id : null,
      status: runStatus,
      errorMessage: errorMessage
    });
  } catch (logErr) {
    // Handle duplicate run error (idempotency)
    if (logErr.code === 11000) {
      console.log('Duplicate run detected, skipping log');
    } else {
      console.error('Failed to log recurring invoice run:', logErr);
    }
  }

  return created;
}

async function generateDueRecurringInvoices() {
  try {
    const now = new Date();
    const startOfToday = getStartOfDay(now);
    
    // Find active templates where next_run_date <= today
    const due = await RecurringInvoice.find({ 
      status: 'active', 
      startDate: { $lte: now }, 
      nextRunDate: { $lte: startOfToday }
    });

    console.log(`Processing ${due.length} due recurring invoice templates`);

    for (const r of due) {
      try {
        await generateForTemplate(r._id);
      } catch (errInner) {
        console.error('Error processing recurring invoice template', r._id, errInner);
        // Continue to next template - don't stop the scheduler
      }
    }
  } catch (err) {
    console.error('Recurring invoice generation error', err);
  }
}

// Scheduler configuration
let task = null;
let schedulerConfig = {
  cronExpression: '1 0 * * *', // Default: daily at 00:01 UTC
  enabled: true
};

function configureScheduler(cronExpression) {
  if (cronExpression) {
    schedulerConfig.cronExpression = cronExpression;
  }
}

function startScheduler() {
  if (task) return;
  
  if (!schedulerConfig.enabled) {
    console.log('Recurring invoice scheduler is disabled');
    return;
  }
  
  console.log(`Starting recurring invoice scheduler with cron: ${schedulerConfig.cronExpression}`);
  
  task = cron.schedule(schedulerConfig.cronExpression, () => {
    console.log('Running scheduled recurring invoice generation...');
    generateDueRecurringInvoices();
  }, { 
    scheduled: true,
    timezone: 'UTC'
  });
  
  // Also run immediately on start (for development/testing)
  // In production, this might be removed
  generateDueRecurringInvoices();
}

function stopScheduler() {
  if (task) {
    task.stop();
    task = null;
    console.log('Recurring invoice scheduler stopped');
  }
}

module.exports = {
  startScheduler,
  stopScheduler,
  configureScheduler,
  generateDueRecurringInvoices,
  generateForTemplate,
  computeNextRunDate,
  checkIdempotency
};
