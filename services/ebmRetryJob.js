const mongoose = require('mongoose');
const EBMSubmissionQueue = require('../models/EBMSubmissionQueue');
const { extractSaveSalesFiscalData } = require('../utils/vsdcPayloadSanitizer');
const ebmService = require('./ebmService');
const EBMQueueService = require('./ebmQueueService');

let running = false;
let intervalHandle = null;

function getBatchSize() {
  return Math.max(1, Number(process.env.EBM_RETRY_BATCH_SIZE || 10));
}

function getIntervalMs() {
  return Math.max(1, Number(process.env.EBM_RETRY_INTERVAL_MINUTES || 5)) * 60 * 1000;
}

const LEGACY_ENDPOINT_MAP = Object.freeze({
  '/trnsSales/saveSales': ebmService.VSDC_ENDPOINTS.SAVE_SALES,
  '/trnsPurchase/selectTrnsPurchaseSales': ebmService.VSDC_ENDPOINTS.SELECT_PURCHASE_SALES,
  '/trnsPurchase/savePurchases': ebmService.VSDC_ENDPOINTS.SAVE_PURCHASES,
  '/stockMaster/saveStockMaster': ebmService.VSDC_ENDPOINTS.SAVE_STOCK_MASTER,
});

function normalizeQueueEndpoint(endpoint) {
  return LEGACY_ENDPOINT_MAP[endpoint] || endpoint;
}

function normalizeQueuePayload(endpoint, payload) {
  if (endpoint !== ebmService.VSDC_ENDPOINTS.SAVE_SALES || !payload) {
    return payload;
  }

  let normalizedPayload = payload;
  if (!payload.salesSttsCd && payload.invcSttsCd) {
    normalizedPayload = { ...normalizedPayload, salesSttsCd: payload.invcSttsCd };
    delete normalizedPayload.invcSttsCd;
  }
  if (typeof normalizedPayload.salesDt === 'string' && /^\d{14}$/.test(normalizedPayload.salesDt)) {
    normalizedPayload = { ...normalizedPayload, salesDt: normalizedPayload.salesDt.slice(0, 8) };
  }

  return normalizedPayload;
}

async function updateSourceDocument(queueRecord, response = null, status = 'submitted', error = null) {
  const models = mongoose.models;
  const now = new Date();
  const isSales = queueRecord.endpoint === ebmService.VSDC_ENDPOINTS.SAVE_SALES;
  const data = isSales ? extractSaveSalesFiscalData(response) : (response?.data || {});
  const update = {};
  let incrementField = 'ebm.retryCount';

  if (isSales && status === 'submitted') {
    const rcptDt = data.rcptDt || data.vsdcRcptPbctDate || response?.resultDt || null;
    Object.assign(update, {
      'ebm.rcptSign': data.rcptSign || null,
      'ebm.intrlData': data.intrlData || null,
      'ebm.rcptNo': data.rcptNo != null ? String(data.rcptNo) : null,
      'ebm.rcptDt': rcptDt,
      'ebm.qrCode': [data.rcptSign, data.intrlData, data.rcptNo, rcptDt].filter(Boolean).join('|'),
      'ebm.salesPayload': queueRecord.payload,
      'ebm.submittedAt': now,
      'ebm.ebmStatus': 'submitted',
      'ebm.lastError': null,
      ...(queueRecord.payload?.orgRcptNo ? { 'ebm.orgRcptNo': queueRecord.payload.orgRcptNo } : {}),
      ...(queueRecord.payload?.rfdRsnCd ? { 'ebm.rfdRsnCd': queueRecord.payload.rfdRsnCd } : {}),
      ...(queueRecord.payload?.rcptTyCd ? { 'ebm.rcptTyCd': queueRecord.payload.rcptTyCd } : {}),
      ...(queueRecord.payload?.pmtTyCd ? { 'ebm.pmtTyCd': queueRecord.payload.pmtTyCd } : {}),
      ...(queueRecord.payload?.salesTyCd ? { 'ebm.salesTyCd': queueRecord.payload.salesTyCd } : {}),
      ...(queueRecord.payload?.cfmDt ? { 'ebm.cfmDt': queueRecord.payload.cfmDt } : {}),
      ...(queueRecord.payload?.prcOrdCd ? { 'ebm.prcOrdCd': queueRecord.payload.prcOrdCd } : {}),
    });
  } else if (queueRecord.endpoint === ebmService.VSDC_ENDPOINTS.SAVE_PURCHASES && status === 'submitted') {
    Object.assign(update, {
      'ebm.ebmStatus': 'submitted',
      'ebm.ebmPurchaseMatchStatus': 'confirmed',
      'ebm.ebmConfirmedAt': now,
      'ebm.submittedAt': now,
      'ebm.lastError': null,
    });
  } else if (
    queueRecord.endpoint === ebmService.VSDC_ENDPOINTS.SAVE_STOCK_ITEMS
    || queueRecord.endpoint === ebmService.VSDC_ENDPOINTS.SAVE_STOCK_MASTER
  ) {
    const ownsPrimaryStockStatus = ['GoodsReceivedNote', 'grn', 'Purchase', 'directPurchase', 'stockMovement', 'stockAdjustment', 'branchTransfer'].includes(queueRecord.documentType);
    incrementField = 'ebm.stockRetryCount';
    Object.assign(update, {
      'ebm.stockStatus': status === 'submitted' ? 'submitted' : 'failed',
      'ebm.stockSubmittedAt': status === 'submitted' ? now : null,
      'ebm.stockLastError': error ? error.message || 'EBM stock retry failed' : null,
      ...(ownsPrimaryStockStatus ? {
        'ebm.ebmStatus': status === 'submitted' ? 'submitted' : 'failed',
        'ebm.submittedAt': status === 'submitted' ? now : null,
        'ebm.lastError': error ? error.message || 'EBM stock retry failed' : null,
      } : {}),
    });
  } else {
    Object.assign(update, {
      'ebm.ebmStatus': status,
      'ebm.lastError': error ? error.message || 'EBM retry failed' : null,
      'ebm.submittedAt': status === 'submitted' ? now : null,
    });
  }

  let Model = null;
  if (queueRecord.documentType === 'invoice' || queueRecord.documentType === 'pos') Model = models.Invoice;
  if (queueRecord.documentType === 'creditNote') Model = models.CreditNote;
  if (queueRecord.documentType === 'purchase') Model = models.PurchaseOrder || models.Purchase;
  if (queueRecord.documentType === 'GoodsReceivedNote' || queueRecord.documentType === 'grn') Model = models.GoodsReceivedNote;
  if (queueRecord.documentType === 'Purchase' || queueRecord.documentType === 'directPurchase') Model = models.Purchase;
  if (queueRecord.documentType === 'stockMovement' || queueRecord.documentType === 'stockAdjustment') Model = models.StockMovement;
  if (queueRecord.documentType === 'stockMaster') Model = models.StockMovement;
  if (queueRecord.documentType === 'branchTransfer') Model = models.StockTransfer;

  if (!Model) return null;
  const doc = await Model.findOneAndUpdate(
    { _id: queueRecord.documentId, $or: [{ company: queueRecord.companyId }, { company_id: queueRecord.companyId }] },
    { $set: update, ...(status !== 'submitted' ? { $inc: { [incrementField]: 1 } } : {}) },
    { new: true },
  );

  if (!doc && queueRecord.documentType === 'purchase' && models.Purchase) {
    return models.Purchase.findOneAndUpdate(
      { _id: queueRecord.documentId, company: queueRecord.companyId },
      { $set: update },
      { new: true },
    );
  }
  return doc;
}

async function createAbandonedNotification(record) {
  try {
    const Notification = require('../models/Notification');
    const User = require('../models/User');
    const admin = await User.findOne({
      company: record.companyId,
      $or: [{ role: 'admin' }, { roles: 'admin' }, { isAdmin: true }],
    }).lean();
    if (!admin) return;
    await Notification.create({
      company: record.companyId,
      user: admin._id,
      type: 'system',
      title: 'EBM submission abandoned',
      message: `${record.documentType} ${record.documentId} failed after ${record.retryCount} attempts: ${record.lastError?.message || 'Unknown error'}`,
      severity: 'critical',
      metadata: {
        ebmQueueId: record._id,
        documentType: record.documentType,
        documentId: record.documentId,
        endpoint: record.endpoint,
        payload: record.payload,
      },
    });
  } catch (error) {
    console.error('[EBMRetry] Failed to create abandoned notification:', error.message);
  }
}

async function processRecord(record) {
  try {
    const normalizedEndpoint = normalizeQueueEndpoint(record.endpoint);
    let normalizedRecord = false;
    if (record.endpoint !== normalizedEndpoint) {
      record.endpoint = normalizedEndpoint;
      normalizedRecord = true;
    }
    const normalizedPayload = normalizeQueuePayload(normalizedEndpoint, record.payload);
    if (record.payload !== normalizedPayload) {
      record.payload = normalizedPayload;
      normalizedRecord = true;
    }
    if (normalizedRecord && typeof record.save === 'function') await record.save();
    const response = await ebmService.call(normalizedEndpoint, normalizedPayload);
    await updateSourceDocument(record, response, 'submitted');
    await EBMQueueService.markSubmitted(record);
    return { id: record._id, status: 'submitted' };
  } catch (error) {
    const isRetryable = error?.retryable !== false;
    const retryCount = record.retryCount + 1;
    const maxRetries = EBMQueueService.getMaxRetries();
    const exhausted = retryCount >= maxRetries;
    const status = !isRetryable ? 'failed' : exhausted ? 'abandoned' : 'pending';
    record.retryCount = retryCount;
    record.maxRetries = maxRetries;
    record.lastAttemptAt = new Date();
    record.lastError = EBMQueueService.normalizeError(error);
    record.isRetryable = isRetryable;
    record.ebmStatus = status;
    record.nextRetryAt = status === 'pending' ? EBMQueueService.calculateNextRetryAt(retryCount) : null;
    record.resolvedAt = status === 'failed' ? new Date() : null;
    record.attempts = record.attempts || [];
    record.attempts.push(EBMQueueService.buildAttempt(retryCount, error, isRetryable));
    await record.save();
    await updateSourceDocument(record, null, 'failed', error);
    if (status === 'abandoned') {
      await EBMQueueService.createAbandonmentAlert(record);
      await createAbandonedNotification(record);
    }
    return { id: record._id, status, error: error.message };
  }
}

async function runOnce() {
  if (running) return { skipped: true };
  running = true;
  try {
    const due = await EBMSubmissionQueue.find({
      ebmStatus: 'pending',
      isRetryable: true,
      nextRetryAt: { $lte: new Date() },
      $expr: { $lt: ['$retryCount', EBMQueueService.getMaxRetries()] },
    })
      .sort({ nextRetryAt: 1, createdAt: 1 })
      .limit(getBatchSize());
    const results = [];
    for (const record of due) {
      try {
        results.push(await processRecord(record));
      } catch (error) {
        console.error('[EBMRetry] Record processing failed:', error.message);
      }
    }
    return { processed: results.length, results };
  } finally {
    running = false;
  }
}

function startRetryJob() {
  if (intervalHandle) return intervalHandle;
  setImmediate(() => runOnce().catch((error) => console.error('[EBMRetry] Startup run failed:', error.message)));
  intervalHandle = setInterval(() => {
    runOnce().catch((error) => console.error('[EBMRetry] Scheduled run failed:', error.message));
  }, getIntervalMs());
  return intervalHandle;
}

module.exports = {
  runOnce,
  startRetryJob,
  processRecord,
  normalizeQueueEndpoint,
  normalizeQueuePayload,
};
