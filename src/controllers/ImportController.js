  /**
 * ImportController - HTTP Layer for imports
 * Handles file upload, job creation, and status polling
 * Non-blocking: returns job ID immediately, client polls for status
 */

const ImportJobService = require('../imports/ImportJobService');
const CsvParser = require('../imports/parsers/CsvParser');
const ProductImportValidator = require('../imports/validators/ProductImportValidator');
const ClientImportValidator = require('../imports/validators/ClientImportValidator');
const SupplierImportValidator = require('../imports/validators/SupplierImportValidator');
const OpeningBalanceValidator = require('../imports/validators/OpeningBalanceValidator');

// Map of type to validator
const VALIDATORS = {
  'products': ProductImportValidator,
  'clients': ClientImportValidator,
  'suppliers': SupplierImportValidator,
  'opening_balances': OpeningBalanceValidator
};

// Map of type to service (for using service layer, not direct model)
const SERVICES = {
  'products': null, // Will require ProductService
  'clients': null,   // Will require ClientService
  'suppliers': null  // Will require SupplierService
};

/**
 * Import products
 * POST /api/v1/import/products
 */
exports.importProducts = async (req, res, next) => {
  try {
    const companyId = req.company._id;
    const userId = req.user._id;
    const fileBuffer = req.file.buffer;

    // Step 1: Create ImportJob with pending status
    const job = await ImportJobService.createJob({
      type: 'products',
      fileName: req.file.originalname,
      fileSize: req.file.size,
      companyId,
      userId
    });

    // Return job ID immediately - non-blocking
    res.status(202).json({
      success: true,
      message: 'Import job created',
      jobId: job._id,
      status: job.status
    });

    // Process in background (don't wait for response)
    processImportInBackground(job._id, fileBuffer, companyId, userId).catch(err => {
      console.error('Background import failed:', err);
    });

  } catch (error) {
    next(error);
  }
};

/**
 * Import clients
 * POST /api/v1/import/clients
 */
exports.importClients = async (req, res, next) => {
  try {
    const companyId = req.company._id;
    const userId = req.user._id;
    const fileBuffer = req.file.buffer;

    const job = await ImportJobService.createJob({
      type: 'clients',
      fileName: req.file.originalname,
      fileSize: req.file.size,
      companyId,
      userId
    });

    res.status(202).json({
      success: true,
      message: 'Import job created',
      jobId: job._id,
      status: job.status
    });

    processImportInBackground(job._id, fileBuffer, companyId, userId).catch(err => {
      console.error('Background import failed:', err);
    });

  } catch (error) {
    next(error);
  }
};

/**
 * Import suppliers
 * POST /api/v1/import/suppliers
 */
exports.importSuppliers = async (req, res, next) => {
  try {
    const companyId = req.company._id;
    const userId = req.user._id;
    const fileBuffer = req.file.buffer;

    const job = await ImportJobService.createJob({
      type: 'suppliers',
      fileName: req.file.originalname,
      fileSize: req.file.size,
      companyId,
      userId
    });

    res.status(202).json({
      success: true,
      message: 'Import job created',
      jobId: job._id,
      status: job.status
    });

    processImportInBackground(job._id, fileBuffer, companyId, userId).catch(err => {
      console.error('Background import failed:', err);
    });

  } catch (error) {
    next(error);
  }
};

/**
 * Import opening balances
 * POST /api/v1/import/opening-balances
 */
exports.importOpeningBalances = async (req, res, next) => {
  try {
    const companyId = req.company._id;
    const userId = req.user._id;
    const fileBuffer = req.file.buffer;

    const job = await ImportJobService.createJob({
      type: 'opening_balance',
      fileName: req.file.originalname,
      fileSize: req.file.size,
      companyId,
      userId
    });

    res.status(202).json({
      success: true,
      message: 'Import job created',
      jobId: job._id,
      status: job.status
    });

    processImportInBackground(job._id, fileBuffer, companyId, userId).catch(err => {
      console.error('Background import failed:', err);
    });

  } catch (error) {
    next(error);
  }
};

/**
 * Get import job status
 * GET /api/v1/import/jobs/:jobId
 */
exports.getJobStatus = async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const companyId = req.company._id;

    const job = await ImportJobService.getJob(jobId, companyId);

    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Import job not found',
        code: 'JOB_NOT_FOUND'
      });
    }

    res.json({
      success: true,
      data: job
    });

  } catch (error) {
    next(error);
  }
};

/**
 * Get import job history
 * GET /api/v1/import/jobs
 */
exports.getJobHistory = async (req, res, next) => {
  try {
    const companyId = req.company._id;
    const { type, status, limit = 20, page = 1 } = req.query;

    const jobs = await ImportJobService.getJobHistory(companyId, {
      type,
      status,
      limit: parseInt(limit),
      skip: (parseInt(page) - 1) * parseInt(limit)
    });

    res.json({
      success: true,
      data: jobs
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Retry a failed import job
 * POST /api/v1/import/jobs/:jobId/retry
 */
exports.retryJob = async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const companyId = req.company._id;
    const fileBuffer = req.file ? req.file.buffer : null;

    if (!fileBuffer) {
      return res.status(400).json({
        success: false,
        message: 'File is required for retry',
        code: 'FILE_REQUIRED'
      });
    }

    const job = await ImportJobService.getJob(jobId, companyId);

    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Import job not found',
        code: 'JOB_NOT_FOUND'
      });
    }

    if (job.status !== 'failed' && job.status !== 'completed_with_errors') {
      return res.status(400).json({
        success: false,
        message: 'Can only retry failed or completed_with_errors jobs',
        code: 'INVALID_JOB_STATUS'
      });
    }

    // Create new job for retry
    const newJob = await ImportJobService.createJob({
      type: job.type,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      companyId,
      userId: req.user._id
    });

    res.status(202).json({
      success: true,
      message: 'Retry job created',
      jobId: newJob._id,
      status: newJob.status
    });

    // Process in background
    ImportJobService.retryJob(newJob._id, companyId, fileBuffer)
      .then(result => {
        console.log(`Retry job ${newJob._id} completed:`, result.result);
      })
      .catch(err => {
        console.error('Retry job failed:', err);
      });

  } catch (error) {
    next(error);
  }
};

/**
 * Get product import template
 * GET /api/v1/import/products/template
 */
exports.getProductTemplate = async (req, res, next) => {
  try {
    const { stringify } = require('csv-stringify/sync');
    
    const template = [
      {
        code: 'PRD001',
        name: 'Sample Product',
        category_name: 'Electronics',
        unit_of_measure: 'piece',
        cost_price: '10.00',
        selling_price: '15.00',
        costing_method: 'fifo',
        reorder_point: '10',
        is_stockable: 'true'
      }
    ];

    const csv = stringify(template, { header: true });
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=product_import_template.csv');
    res.send(csv);

  } catch (error) {
    next(error);
  }
};

/**
 * Get client import template
 * GET /api/v1/import/clients/template
 */
exports.getClientTemplate = async (req, res, next) => {
  try {
    const { stringify } = require('csv-stringify/sync');
    
    const template = [
      {
        code: 'CLI001',
        name: 'Sample Client',
        email: 'client@example.com',
        phone: '+1234567890',
        address: '123 Main Street',
        city: 'New York',
        country: 'USA',
        payment_terms: 'net30',
        credit_limit: '1000'
      }
    ];

    const csv = stringify(template, { header: true });
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=client_import_template.csv');
    res.send(csv);

  } catch (error) {
    next(error);
  }
};

/**
 * Get supplier import template
 * GET /api/v1/import/suppliers/template
 */
exports.getSupplierTemplate = async (req, res, next) => {
  try {
    const { stringify } = require('csv-stringify/sync');
    
    const template = [
      {
        code: 'SUP001',
        name: 'Sample Supplier',
        email: 'supplier@example.com',
        phone: '+1234567890',
        address: '456 Supplier Ave',
        city: 'Los Angeles',
        country: 'USA',
        payment_terms: 'net30'
      }
    ];

    const csv = stringify(template, { header: true });
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=supplier_import_template.csv');
    res.send(csv);

  } catch (error) {
    next(error);
  }
};

/**
 * Get opening balance import template
 * GET /api/v1/import/opening-balances/template
 */
exports.getOpeningBalanceTemplate = async (req, res, next) => {
  try {
    const { stringify } = require('csv-stringify/sync');
    
    const template = [
      {
        account_code: '1000',
        account_name: 'Cash',
        debit: '5000',
        credit: '0',
        description: 'Opening balance'
      },
      {
        account_code: '2000',
        account_name: 'Accounts Payable',
        debit: '0',
        credit: '2000',
        description: 'Opening balance'
      }
    ];

    const csv = stringify(template, { header: true });
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=opening_balance_template.csv');
    res.send(csv);

  } catch (error) {
    next(error);
  }
};

/**
 * Background function to process import
 * Runs after response sent to client
 */
async function processImportInBackground(jobId, fileBuffer, companyId, userId) {
  try {
    // Get job
    const job = await ImportJobService.getJob(jobId, companyId);
    if (!job) return;

    // Parse CSV
    const parsed = CsvParser.parse(fileBuffer);
    const records = parsed.rows;
    
    job.totalRows = records.length;
    await job.save();

    if (records.length === 0) {
      await job.fail(new Error('CSV file is empty'));
      return;
    }

    // Validate headers
    const headers = parsed.headers;
    const Validator = VALIDATORS[job.type];
    
    if (!Validator) {
      await job.fail(new Error(`Unknown import type: ${job.type}`));
      return;
    }

    const headerValidation = Validator.validateHeaders(headers);
    if (!headerValidation.valid) {
      await job.fail(new Error(headerValidation.message));
      return;
    }

    // Validate each row
    const validatedRecords = [];
    const validationErrors = [];

    for (let i = 0; i < records.length; i++) {
      const validation = Validator.validate(records[i], i + 2);
      
      if (validation.valid) {
        validatedRecords.push(validation.data);
      } else {
        validationErrors.push(...validation.errors);
      }
    }

    job.failedRows = validationErrors.length;
    job.errors = validationErrors;
    await job.save();

    // Process via ImportJobService (uses processor)
    const result = await ImportJobService.processImport(job, fileBuffer, { companyId, userId });
    
    console.log(`Import ${jobId} completed: ${result.result?.successfulRows} successful, ${result.result?.failedRows} failed`);
    
  } catch (error) {
    console.error(`Import ${jobId} failed:`, error);
    const job = await ImportJobService.getJob(jobId, companyId);
    if (job) {
      await job.fail(error);
    }
  }
}