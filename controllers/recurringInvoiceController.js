const RecurringInvoice = require('../models/RecurringInvoice');
const RecurringInvoiceRun = require('../models/RecurringInvoiceRun');
const recurringService = require('../services/recurringService');
const { parsePagination, paginationMeta } = require('../utils/pagination');

// List recurring templates
// GET /api/recurring-templates - List. Filters: client_id, status, frequency
exports.getRecurringInvoices = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { status, client_id, frequency } = req.query;
    
    const query = { company: companyId };
    if (status) {
      query.status = status;
    }
    if (client_id) {
      query.client = client_id;
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
    const payload = {
      ...req.body,
      company: companyId,
      createdBy: req.user.id
    };
    
    // Set default values
    if (!payload.status) {
      payload.status = 'active';
    }
    if (!payload.startDate) {
      payload.startDate = new Date();
    }
    if (!payload.nextRunDate) {
      payload.nextRunDate = new Date();
    }
    
    const rec = await RecurringInvoice.create(payload);

    // Compute initial nextRunDate if not provided
    if (rec.schedule && rec.startDate && !payload.nextRunDate) {
      try {
        const next = recurringService.computeNextRunDate(rec.schedule, rec.startDate);
        rec.nextRunDate = next;
        await rec.save();
      } catch (e) {
        // ignore schedule compute errors
      }
    }
    
    res.status(201).json({ success: true, data: rec });
  } catch (err) {
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
    
    const rec = await RecurringInvoice.findOneAndUpdate(
      { _id: req.params.id, company: companyId }, 
      req.body, 
      { new: true, runValidators: true }
    );
    
    // Recompute nextRunDate if schedule changed
    if (rec.schedule && rec.startDate) {
      try {
        const next = recurringService.computeNextRunDate(rec.schedule, rec.startDate);
        rec.nextRunDate = next;
        await rec.save();
      } catch (e) {}
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
    next(err);
  }
};

// Delete
exports.deleteRecurringInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const rec = await RecurringInvoice.findOne({ _id: req.params.id, company: companyId });
    if (!rec) return res.status(404).json({ success: false, message: 'Not found' });
    await rec.deleteOne();
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    next(err);
  }
};

// Manual trigger for generation (admin)
exports.triggerGeneration = async (req, res, next) => {
  try {
    await recurringService.generateDueRecurringInvoices();
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

    const invoice = await recurringService.generateForTemplate(rec._id);
    
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
