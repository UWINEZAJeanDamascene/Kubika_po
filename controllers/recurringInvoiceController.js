const RecurringInvoice = require('../models/RecurringInvoice');
const RecurringInvoiceRun = require('../models/RecurringInvoiceRun');
const recurringService = require('../services/recurringService');
const { parsePagination, paginationMeta } = require('../utils/pagination');
const Client = require('../models/Client');
const Product = require('../models/Product');
const Warehouse = require('../models/Warehouse');
const Invoice = require('../models/Invoice');
const { dbClient } = require('../lib/prisma');
const { runInTransaction } = require('../services/transactionService');
const { generateObjectId } = require('../utils/objectId');

const FREQUENCIES = new Set(['daily', 'weekly', 'monthly', 'quarterly', 'annually']);
const getId = (value) => value && typeof value === 'object'
  ? String(value._id || value.id || '')
  : String(value || '');

function parseDate(value, field, required = false) {
  if (value == null || value === '') {
    if (required) throw new Error(`${field} is required.`);
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${field} must be a valid date.`);
  return date;
}

function normalizeSchedule(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const frequency = String(raw.frequency || '').toLowerCase();
  const interval = Number(raw.interval ?? 1);
  if (!FREQUENCIES.has(frequency)) throw new Error('Choose a supported recurring frequency.');
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) throw new Error('Schedule interval must be from 1 to 365.');
  const schedule = { frequency, interval };
  if (frequency === 'weekly') {
    if (raw.dayOfWeek != null && raw.dayOfWeek !== '') {
      const day = Number(raw.dayOfWeek);
      if (!Number.isInteger(day) || day < 0 || day > 6) throw new Error('Choose a valid weekday for the schedule.');
      schedule.dayOfWeek = day;
    }
  }
  if (['monthly', 'quarterly'].includes(frequency) && raw.dayOfMonth != null && raw.dayOfMonth !== '') {
    const day = Number(raw.dayOfMonth);
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('Day of month must be from 1 to 31.');
    schedule.dayOfMonth = day;
  }
  if (raw.dueDays != null) {
    const dueDays = Number(raw.dueDays);
    if (!Number.isInteger(dueDays) || dueDays < 0 || dueDays > 365) throw new Error('Payment terms must be from 0 to 365 days.');
    schedule.dueDays = dueDays;
  }
  return schedule;
}

async function validateTemplateData(body, companyId, current) {
  const clientId = getId(body.client ?? current?.client);
  if (!clientId || !await Client.findOne({ _id: clientId, company: companyId })) throw new Error('Select a client in this company.');
  const schedule = body.schedule !== undefined ? normalizeSchedule(body.schedule) : normalizeSchedule(current?.schedule);
  const startDate = parseDate(body.startDate ?? current?.startDate, 'Start date', true);
  const endDate = body.endDate !== undefined ? parseDate(body.endDate, 'End date') : parseDate(current?.endDate, 'End date');
  if (endDate && endDate < startDate) throw new Error('End date cannot be before the start date.');
  const currencyCode = String(body.currencyCode ?? current?.currencyCode ?? 'RWF').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode)) throw new Error('Currency must be a valid three-letter ISO code.');

  let lines;
  if (body.lines !== undefined) {
    if (!Array.isArray(body.lines) || body.lines.length === 0) throw new Error('Add at least one invoice line.');
    lines = [];
    for (const line of body.lines) {
      const productId = getId(line.product);
      const product = productId && await Product.findOne({ _id: productId, company: companyId });
      if (!product) throw new Error('Each line must use a valid product from this company.');
      if ((body.autoConfirm ?? current?.autoConfirm) === true
          && product.isStockable !== false
          && product.trackingType && product.trackingType !== 'none') {
        throw new Error('Auto-confirm is unavailable for batch or serial tracked products. Generate a draft and assign traceability before confirming.');
      }
      const qty = Number(line.qty ?? line.quantity);
      const unitPrice = Number(line.unitPrice);
      const taxRate = Number(line.taxRate ?? 0);
      const discountPct = Number(line.discountPct ?? line.discount ?? 0);
      if (!Number.isFinite(qty) || qty <= 0) throw new Error('Line quantity must be greater than zero.');
      if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error('Unit price cannot be negative.');
      if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) throw new Error('Tax rate must be from 0 to 100%.');
      if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) throw new Error('Discount must be from 0 to 100%.');
      const warehouseId = getId(line.warehouse);
      if (warehouseId && !await Warehouse.findOne({ _id: warehouseId, company: companyId })) throw new Error('Selected warehouse does not belong to this company.');
      lines.push({ ...line, product: productId, qty, unitPrice, taxRate, discountPct, warehouse: warehouseId || null });
    }
  } else if (!current) {
    throw new Error('Add at least one invoice line.');
  }
  return { client: clientId, schedule, startDate, endDate, lines, currencyCode };
}

// List recurring templates
// GET /api/recurring-templates - List. Filters: client_id, status, frequency
exports.getRecurringInvoices = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { status, frequency } = req.query;
    const clientId = req.query.client_id || req.query.clientId;
    
    const query = { company: companyId };
    if (status) {
      query.status = status;
    }
    if (clientId) {
      query.client = clientId;
    }
    if (frequency) {
      query['schedule.frequency'] = frequency;
    }

    const { page, limit, skip } = parsePagination(req.query);
    const total = await RecurringInvoice.countDocuments(query);
    const recs = await RecurringInvoice.find(query)
      .populate('client lines.product createdBy')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      success: true,
      count: recs.length,
      data: recs,
      pagination: paginationMeta(page, limit, total),
    });
  } catch (err) {
    next(err);
  }
};

// Get single
exports.getRecurringInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const rec = await RecurringInvoice.findOne({ _id: req.params.id, company: companyId })
      .populate('client lines.product createdBy');
    if (!rec) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: rec });
  } catch (err) {
    next(err);
  }
};

// Create template
// POST /api/recurring-templates — Create template
exports.createRecurringInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const normalized = await validateTemplateData(req.body, companyId);
    const payload = {
      ...normalized,
      company: companyId,
      createdBy: req.user.id,
      status: 'active',
      autoConfirm: req.body.autoConfirm === true,
      currencyCode: normalized.currencyCode,
      notes: req.body.notes || null,
      nextRunDate: normalized.startDate,
    };
    const rec = await RecurringInvoice.create(payload);
    res.status(201).json({ success: true, data: rec });
  } catch (err) {
    if (err.message && /required|supported|schedule|weekday|frequency|date|line|product|client|warehouse|quantity|price|tax|discount|payment terms|currency/i.test(err.message)) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  }
};

// Update
// PUT /api/recurring-templates/:id — Edit (only when status is active or paused)
exports.updateRecurringInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    // Find existing template
    const recOld = await RecurringInvoice.findOne({ _id: req.params.id, company: companyId });
    if (!recOld) {
      return res.status(404).json({ success: false, message: 'Not found' });
    }
    
    // Validation: can only edit when status is active or paused
    if (!['active', 'paused'].includes(recOld.status)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Can only edit templates when status is active or paused' 
      });
    }
    
    const normalized = await validateTemplateData(req.body, companyId, recOld);
    const scheduleChanged = req.body.schedule !== undefined || req.body.startDate !== undefined;
    const nextRunDate = scheduleChanged
      ? new Date(Math.max(
        (recOld.lastRunAt
          ? recurringService.computeNextRunDate(normalized.schedule, recOld.lastRunAt)
          : normalized.startDate).getTime(),
        normalized.startDate.getTime(),
      ))
      : recOld.nextRunDate;
    const update = {
      client: normalized.client,
      schedule: normalized.schedule,
      startDate: normalized.startDate,
      endDate: normalized.endDate,
      nextRunDate,
      ...(req.body.autoConfirm !== undefined ? { autoConfirm: req.body.autoConfirm === true } : {}),
      currencyCode: normalized.currencyCode,
      ...(req.body.notes !== undefined ? { notes: req.body.notes } : {}),
    };
    let rec;
    await runInTransaction(async () => {
      rec = await RecurringInvoice.findOneAndUpdate(
        { _id: req.params.id, company: companyId, status: { $in: ['active', 'paused'] } },
        update,
        { new: true, runValidators: true },
      );
      if (!rec) throw new Error('Recurring invoice status changed while it was being edited.');
      if (normalized.lines) {
        const db = dbClient();
        await db.recurringInvoiceLine.deleteMany({
          where: { companyId: String(companyId), recurringInvoiceId: String(rec._id) },
        });
        await db.recurringInvoiceLine.createMany({
          data: normalized.lines.map((line, lineOrder) => ({
            id: generateObjectId(),
            companyId: String(companyId),
            recurringInvoiceId: String(rec._id),
            lineOrder,
            productId: String(line.product),
            productName: line.productName || null,
            productCode: line.productCode || null,
            description: line.description || null,
            qty: line.qty,
            unit: line.unit || null,
            unitPrice: line.unitPrice,
            discountPct: line.discountPct,
            taxRate: line.taxRate,
            taxCode: line.taxCode || 'A',
            warehouseId: line.warehouse ? String(line.warehouse) : null,
          })),
        });
      }
    });
    if (normalized.lines) {
      rec = await RecurringInvoice.findOne({ _id: req.params.id, company: companyId })
        .populate('client lines.product createdBy');
    }
    
    // If template was active and is now paused, notify
    try {
      if (recOld && recOld.status === 'active' && rec && rec.status === 'paused') {
        const { notifyRecurringPaused } = require('../services/notificationHelper');
        await notifyRecurringPaused(companyId, rec);
      }
    } catch (e) {
      console.error('notifyRecurringPaused failed', e);
    }
    
    res.json({ success: true, data: rec });
  } catch (err) {
    if (err.message && /required|supported|schedule|weekday|frequency|date|line|product|client|warehouse|quantity|price|tax|discount|payment terms|currency|status changed/i.test(err.message)) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  }
};

// Delete
exports.deleteRecurringInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const rec = await RecurringInvoice.findOne({ _id: req.params.id, company: companyId });
    if (!rec) return res.status(404).json({ success: false, message: 'Not found' });
    const runCount = await RecurringInvoiceRun.countDocuments({ recurringInvoice: rec._id, company: companyId });
    const generatedInvoice = await Invoice.findOne({ generatedFromRecurring: rec._id, company: companyId });
    if (runCount || generatedInvoice) {
      return res.status(409).json({ success: false, message: 'This template has run history. Cancel it to preserve its audit trail.' });
    }
    await rec.deleteOne();
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    next(err);
  }
};

// Manual trigger for generation (admin)
exports.triggerGeneration = async (req, res, next) => {
  try {
    await recurringService.generateDueRecurringInvoices({ companyId: req.user.company._id });
    res.json({ success: true, message: 'Generation started' });
  } catch (err) {
    next(err);
  }
};

// Trigger a specific template immediately
exports.triggerTemplate = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const rec = await RecurringInvoice.findOne({ _id: req.params.id, company: companyId });
    if (!rec) return res.status(404).json({ success: false, message: 'Template not found' });

    const invoice = await recurringService.generateForTemplate(rec._id, { companyId, scheduled: false });
    
    if (!invoice) {
      return res.status(200).json({ 
        success: true, 
        message: 'Template already run today (idempotent)',
        data: null 
      });
    }
    
    res.json({ success: true, data: invoice });
  } catch (err) {
    next(err);
  }
};

// Get runs for a template
// GET /api/recurring-templates/:id/runs — History of all invoice runs for this template
exports.getRecurringInvoiceRuns = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { templateId } = req.params;
    
    // Verify template exists and belongs to company
    const template = await RecurringInvoice.findOne({ _id: templateId, company: companyId });
    if (!template) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }
    
    const runQuery = {
      recurringInvoice: templateId,
      company: companyId,
    };
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 20 });
    const total = await RecurringInvoiceRun.countDocuments(runQuery);
    const runs = await RecurringInvoiceRun.find(runQuery)
      .populate('invoice', 'referenceNo status totalAmount')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      success: true,
      count: runs.length,
      data: runs,
      pagination: paginationMeta(page, limit, total),
    });
  } catch (err) {
    next(err);
  }
};

// Pause a recurring invoice
// POST /api/recurring-templates/:id/pause — Pause
exports.pauseRecurringInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const rec = await RecurringInvoice.findOneAndUpdate(
      { _id: req.params.id, company: companyId, status: 'active' },
      { status: 'paused' },
      { new: true }
    );
    if (!rec) return res.status(404).json({ success: false, message: 'Template not found or not active' });
    res.json({ success: true, data: rec });
  } catch (err) {
    next(err);
  }
};

// Resume a recurring invoice
// POST /api/recurring-templates/:id/resume — Resume
exports.resumeRecurringInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const rec = await RecurringInvoice.findOneAndUpdate(
      { _id: req.params.id, company: companyId, status: 'paused' },
      { status: 'active' },
      { new: true }
    );
    if (!rec) return res.status(404).json({ success: false, message: 'Template not found or not paused' });
    res.json({ success: true, data: rec });
  } catch (err) {
    next(err);
  }
};

// Cancel a recurring invoice
// POST /api/recurring-templates/:id/cancel — Cancel permanently
exports.cancelRecurringInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const rec = await RecurringInvoice.findOneAndUpdate(
      { _id: req.params.id, company: companyId },
      { status: 'cancelled' },
      { new: true }
    );
    if (!rec) return res.status(404).json({ success: false, message: 'Template not found' });
    res.json({ success: true, data: rec });
  } catch (err) {
    next(err);
  }
};
