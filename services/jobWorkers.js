/**
 * Job Workers - Process background jobs
 * 
 * NOTE: If Redis is not configured, workers will not be initialized
 * and jobs will be processed synchronously where needed
 */

const { Worker } = require('bullmq');
const { redisClient, isRedisConfigured , createQueueConnection } = require('../config/redis');

// BullMQ needs its own connection: it rejects a client with maxRetriesPerRequest
// set, and its blocking reads would otherwise stall shared cache traffic.
const queueConnection = createQueueConnection();
const Invoice = require('../models/Invoice');
const Product = require('../models/Product');
const Company = require('../models/Company');
const RecurringInvoice = require('../models/RecurringInvoice');
const emailService = require('./emailService');

const { JOB_TYPES, isQueueAvailable } = require('./jobQueue');
const { aggregateWithTimeout } = require('../utils/mongoAggregation');

// Store worker references
const workers = {};

// Check if Redis is available
const isRedisAvailable = () => {
  if (!isRedisConfigured()) {
    return false;
  }
  // Check if client has connected successfully
  return redisClient && redisClient.status === 'ready';
};

/**
 * Create a worker for a specific queue
 */
function createWorker(queueName, processorFn) {
  const worker = new Worker(queueName, processorFn, {
    connection: queueConnection,
    concurrency: 5, // Process 5 jobs concurrently
    limiter: {
      max: 10,
      duration: 1000 // 10 jobs per second
    }
  });

  worker.on('completed', (job) => {
    console.log(`Worker ${queueName}: Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Worker ${queueName}: Job ${job.id} failed:`, err.message);
  });

  worker.on('error', (err) => {
    console.error(`Worker ${queueName} error:`, err);
  });

  return worker;
}

/**
 * Nightly Aggregation Worker
 * Pre-computes expensive report data
 */
const nightlyAggregationProcessor = async (job) => {
  console.log(`Starting nightly aggregation job ${job.id}`);
  
  const companies = await Company.find({});
  
  for (const company of companies) {
    try {
      // Pre-compute Balance Sheet data
      await precomputeBalanceSheet(company._id);
      
      // Pre-compute P&L data
      await precomputeProfitAndLoss(company._id);
      
      // Pre-compute inventory valuation
      await precomputeInventoryValuation(company._id);
      
      console.log(`Nightly aggregation completed for company ${company.name}`);
    } catch (error) {
      console.error(`Error in nightly aggregation for company ${company.name}:`, error);
    }
  }
  
  return { companiesProcessed: companies.length };
};

/**
 * Pre-compute Balance Sheet totals
 */
async function precomputeBalanceSheet(companyId) {
  const pipeline = [
    { $match: { company: companyId } },
    { $facet: {
      totalInvoices: [{ $count: 'count' }],
      totalRevenue: [{ $group: { _id: null, total: { $sum: '$grandTotal' } } }],
      totalTax: [{ $group: { _id: null, total: { $sum: '$totalTax' } } }],
      totalReceivables: [
        { $match: { status: { $in: ['draft', 'confirmed', 'partial'] } } },
        { $group: { _id: null, total: { $sum: '$balance' } } }
      ]
    }}
  ];
  
  const results = await aggregateWithTimeout(Invoice, pipeline, 'report');
  
  // Store pre-computed data in cache or dedicated collection
  // This can be used by reports instead of running full aggregation
  return results[0];
}

/**
 * Pre-compute P&L totals
 */
async function precomputeProfitAndLoss(companyId) {
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);
  
  const pipeline = [
    { 
      $match: { 
        company: companyId, 
        status: 'paid',
        paidDate: { $gte: yearStart, $lte: now }
      } 
    },
    { $facet: {
      revenue: [{ $group: { _id: null, total: { $sum: '$grandTotal' } } }],
      tax: [{ $group: { _id: null, total: { $sum: '$totalTax' } } }],
      discount: [{ $group: { _id: null, total: { $sum: '$totalDiscount' } } }]
    }}
  ];
  
  const results = await aggregateWithTimeout(Invoice, pipeline, 'report');
  return results[0];
}

/**
 * Pre-compute Inventory Valuation
 */
async function precomputeInventoryValuation(companyId) {
  const pipeline = [
    { $match: { company: companyId, isArchived: false } },
    { $project: { 
      stockValue: { $multiply: ['$currentStock', '$averageCost'] }
    }},
    { $group: { 
      _id: null, 
      totalValue: { $sum: '$stockValue' },
      totalProducts: { $sum: 1 },
      totalStock: { $sum: '$currentStock' }
    }}
  ];
  
  const results = await aggregateWithTimeout(Product, pipeline, 'report');
  return results[0] || { totalValue: 0, totalProducts: 0, totalStock: 0 };
}

/**
 * Daily Summary Worker
 */
const dailySummaryProcessor = async (job) => {
  console.log(`Starting daily summary job ${job.id}`);
  
  const companies = await Company.find({});
  const summaries = [];
  
  for (const company of companies) {
    try {
      const summary = {
        companyId: company._id,
        date: new Date(),
        stats: {
          invoicesToday: await Invoice.countDocuments({
            company: company._id,
            createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) }
          }),
          productsLowStock: await Product.countDocuments({
            company: company._id,
            isArchived: false,
            $expr: { $lte: ['$currentStock', '$lowStockThreshold'] }
          }),
          inventoryValue: await precomputeInventoryValuation(company._id)
        }
      };
      summaries.push(summary);
    } catch (error) {
      console.error(`Error in daily summary for company ${company.name}:`, error);
    }
  }
  
  return { summaries };
};

/**
 * Monthly Summary Worker
 */
const monthlySummaryProcessor = async (job) => {
  console.log(`Starting monthly summary job ${job.id}`);
  
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthEnd = new Date(monthStart);
  lastMonthEnd.setDate(lastMonthEnd.getDate() - 1);
  const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1);
  
  const companies = await Company.find({});
  
  for (const company of companies) {
    try {
      const summary = {
        companyId: company._id,
        month: now.toISOString().slice(0, 7),
        stats: {
          totalInvoices: await Invoice.countDocuments({
            company: company._id,
            createdAt: { $gte: monthStart }
          }),
          totalRevenue: await aggregateWithTimeout(Invoice, [
            { $match: { company: company._id, status: 'paid', paidDate: { $gte: monthStart } } },
            { $group: { _id: null, total: { $sum: '$grandTotal' } } }
          ], 'report'),
          totalPurchases: await precomputeInventoryValuation(company._id)
        }
      };
      
      console.log(`Monthly summary for ${company.name}:`, summary);
    } catch (error) {
      console.error(`Error in monthly summary for company ${company.name}:`, error);
    }
  }
  
  return { completed: true };
};

/**
 * Recurring Invoice Worker
 */
const recurringInvoiceProcessor = async (job) => {
  const { companyId, recurringInvoiceId } = job.data;
  console.log(`Processing recurring invoice ${recurringInvoiceId} for company ${companyId}`);
  
  const recurring = await RecurringInvoice.findOne({
    _id: recurringInvoiceId,
    company: companyId,
    status: 'active'
  });
  
  if (!recurring) {
    return { success: false, reason: 'Recurring invoice not found or inactive' };
  }
  
  // Check if it's time to generate
  const now = new Date();
  const nextRun = new Date(recurring.nextRunDate);
  
  if (nextRun > now) {
    return { success: false, reason: 'Not time to generate yet' };
  }
  
  // Generate the invoice
  const invoice = await Invoice.create({
    company: companyId,
    client: recurring.client,
    items: recurring.items,
    subtotal: recurring.subtotal,
    totalTax: recurring.totalTax,
    grandTotal: recurring.grandTotal,
    status: 'draft',
    invoiceDate: now,
    dueDate: new Date(now.getTime() + (recurring.paymentTerms || 30) * 24 * 60 * 60 * 1000),
    recurringSource: recurring._id
  });
  
  // Update next run date
  const nextDate = new Date(now);
  switch (recurring.frequency) {
    case 'daily':
      nextDate.setDate(nextDate.getDate() + 1);
      break;
    case 'weekly':
      nextDate.setDate(nextDate.getDate() + 7);
      break;
    case 'monthly':
      nextDate.setMonth(nextDate.getMonth() + 1);
      break;
    case 'quarterly':
      nextDate.setMonth(nextDate.getMonth() + 3);
      break;
    case 'yearly':
      nextDate.setFullYear(nextDate.getFullYear() + 1);
      break;
  }
  
  recurring.lastRunDate = now;
  recurring.nextRunDate = nextDate;
  await recurring.save();
  
  return { success: true, invoiceId: invoice._id };
};


/**
 * Email Worker
 */
const emailProcessor = async (job) => {
  const { to, subject, template, data } = job.data;
  console.log(`Sending email to ${to}: ${subject}`);
  
  try {
    // Use email service based on template
    if (template === 'invoice') {
      await emailService.sendInvoiceEmail(data.invoice, data.company, data.client);
    } else if (template === 'low-stock') {
      await emailService.sendLowStockAlert(data.product, data.company);
    } else {
      // Generic email
      await emailService.sendGenericEmail(to, subject, data);
    }
    
    return { success: true };
  } catch (error) {
    console.error(`Email sending failed:`, error);
    throw error;
  }
};

/**
 * Initialize all workers - only if Redis is available
 */
function initializeWorkers() {
  // Check if Redis is available before initializing workers
  if (!isRedisAvailable() || !isQueueAvailable()) {
    console.log('⚠️  Redis not available - job workers will not be initialized');
    console.log('   Background jobs are disabled. Set REDIS_URL to enable.');
    return;
  }
  
  try {
    workers.highPriority = createWorker('highPriority', emailProcessor);
    workers.default = createWorker('default', recurringInvoiceProcessor);
    workers.background = createWorker('background', async (job) => {
      switch (job.name) {
        case JOB_TYPES.NIGHTLY_AGGREGATION:
          return await nightlyAggregationProcessor(job);
        case JOB_TYPES.DAILY_SUMMARY:
          return await dailySummaryProcessor(job);
        case JOB_TYPES.MONTHLY_SUMMARY:
          return await monthlySummaryProcessor(job);
        default:
          console.log(`Unknown background job: ${job.name}`);
      }
    });
    
    console.log('✅ All job workers initialized');
  } catch (error) {
    console.error('❌ Failed to initialize job workers:', error.message);
  }
}

/**
 * Close all workers
 */
async function closeWorkers() {
  for (const worker of Object.values(workers)) {
    if (worker) {
      await worker.close();
    }
  }
  console.log('All workers closed');
}

/**
 * Check if workers are initialized
 */
function areWorkersInitialized() {
  return Object.keys(workers).length > 0;
}

module.exports = {
  initializeWorkers,
  closeWorkers,
  areWorkersInitialized,
  nightlyAggregationProcessor,
  dailySummaryProcessor,
  monthlySummaryProcessor,
  recurringInvoiceProcessor,
  emailProcessor
};
