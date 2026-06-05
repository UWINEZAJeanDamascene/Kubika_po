const EBMSubmissionQueue = require('../models/EBMSubmissionQueue');
const EBMAlert = require('../models/EBMAlert');
const mongoose = require('mongoose');

function toBoolRetryable(error) {
  return error?.retryable !== false;
}

function normalizeError(error) {
  return {
    message: error?.message || 'EBM submission failed',
    code: error?.code || null,
    status: error?.status || null,
    response: error?.response || null,
  };
}

function buildAttempt(attemptNumber, error, isRetryable = toBoolRetryable(error)) {
  const normalized = normalizeError(error);
  return {
    attemptNumber,
    attemptedAt: new Date(),
    errorCode: normalized.code,
    errorMessage: normalized.message,
    httpStatus: normalized.status,
    isRetryable,
  };
}

function getMaxRetries() {
  return Math.max(1, Number(process.env.EBM_MAX_RETRIES || 5));
}

function getBaseDelaySeconds() {
  return Math.max(1, Number(process.env.EBM_RETRY_BASE_DELAY_SECONDS || 60));
}

function calculateNextRetryAt(retryCount = 0, baseDelaySeconds = getBaseDelaySeconds()) {
  const delaySeconds = baseDelaySeconds * Math.pow(2, Math.max(0, retryCount));
  return new Date(Date.now() + delaySeconds * 1000);
}

async function upsertFailure({
  companyId,
  documentType,
  documentId,
  endpoint,
  operationKey = 'default',
  payload,
  error,
  isRetryable = toBoolRetryable(error),
}) {
  const maxRetries = getMaxRetries();
  const existing = await EBMSubmissionQueue.findOne({ companyId, documentType, documentId, endpoint, operationKey });
  const retryCount = existing ? existing.retryCount + 1 : 1;
  const exhausted = retryCount >= maxRetries;
  const ebmStatus = !isRetryable ? 'failed' : exhausted ? 'abandoned' : 'pending';
  const lastError = normalizeError(error);

  const record = await EBMSubmissionQueue.findOneAndUpdate(
    { companyId, documentType, documentId, endpoint, operationKey },
    {
      $set: {
        companyId,
        documentType,
        documentId,
        endpoint,
        operationKey,
        payload,
        ebmStatus,
        retryCount,
        maxRetries,
        nextRetryAt: isRetryable && !exhausted ? calculateNextRetryAt(retryCount) : null,
        lastAttemptAt: new Date(),
        lastError,
        isRetryable,
        resolvedAt: ebmStatus === 'failed' ? new Date() : null,
      },
      $push: { attempts: buildAttempt(retryCount, error, isRetryable) },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  if (ebmStatus === 'abandoned') {
    await createAbandonmentAlert(record);
  }

  return record;
}

async function markSubmitted({ companyId, documentType, documentId, endpoint, operationKey = 'default' }) {
  return EBMSubmissionQueue.findOneAndUpdate(
    { companyId, documentType, documentId, endpoint, operationKey },
    {
      $set: {
        ebmStatus: 'submitted',
        lastError: { message: null, code: null, status: null, response: null },
        resolvedAt: new Date(),
        isRetryable: false,
      },
    },
    { new: true },
  );
}

async function resetForManualRetry(queueId, companyId) {
  const item = await EBMSubmissionQueue.findOne({ _id: queueId, companyId });
  if (!item) return null;
  if (!['pending', 'failed', 'abandoned'].includes(item.ebmStatus)) {
    const error = new Error(`Cannot retry ${item.ebmStatus} queue records`);
    error.statusCode = 400;
    throw error;
  }
  if (item.ebmStatus === 'abandoned') item.retryCount = 0;
  item.ebmStatus = 'pending';
  item.nextRetryAt = new Date();
  item.resolvedAt = null;
  item.isRetryable = true;
  const saved = await item.save();
  await resetSourceDocumentStatus(saved).catch(() => {});
  return saved;
}

async function resetSourceDocumentStatus(queueItem) {
  const models = mongoose.models;
  const isStockEndpoint = queueItem.endpoint === '/stock/saveStockItems'
    || queueItem.endpoint === '/stock/saveStockMaster'
    || queueItem.endpoint === '/stockMaster/saveStockMaster';
  let Model = null;
  if (queueItem.documentType === 'invoice' || queueItem.documentType === 'pos') Model = models.Invoice;
  if (queueItem.documentType === 'creditNote') Model = models.CreditNote;
  if (queueItem.documentType === 'purchase') Model = models.PurchaseOrder || models.Purchase;
  if (queueItem.documentType === 'GoodsReceivedNote' || queueItem.documentType === 'grn') Model = models.GoodsReceivedNote;
  if (queueItem.documentType === 'Purchase' || queueItem.documentType === 'directPurchase') Model = models.Purchase;
  if (queueItem.documentType === 'stockMovement' || queueItem.documentType === 'stockAdjustment') Model = models.StockMovement;
  if (queueItem.documentType === 'branchTransfer') Model = models.StockTransfer;
  if (!Model) return null;

  const update = isStockEndpoint
    ? {
      'ebm.stockStatus': 'pending',
      'ebm.stockLastError': null,
      ...(['GoodsReceivedNote', 'Purchase', 'StockMovement', 'StockTransfer'].includes(Model.modelName)
        ? { 'ebm.ebmStatus': 'pending', 'ebm.lastError': null }
        : {}),
    }
    : {
      'ebm.ebmStatus': 'pending',
      'ebm.lastError': null,
      'ebm.retryCount': 0,
    };

  return Model.findOneAndUpdate(
    { _id: queueItem.documentId, $or: [{ company: queueItem.companyId }, { company_id: queueItem.companyId }] },
    { $set: update },
    { new: true },
  );
}

async function createAbandonmentAlert(record) {
  const lastError = record.lastError || {};
  return EBMAlert.findOneAndUpdate(
    { queueId: record._id, status: { $ne: 'reset' } },
    {
      $set: {
        companyId: record.companyId,
        queueId: record._id,
        documentType: record.documentType,
        documentId: record.documentId,
        endpoint: record.endpoint,
        operationKey: record.operationKey || 'default',
        attemptsMade: record.retryCount,
        lastErrorMessage: lastError.message || null,
        lastErrorCode: lastError.code || null,
        lastHttpStatus: lastError.status || null,
        payload: record.payload,
        abandonedAt: new Date(),
        acknowledged: false,
        acknowledgedAt: null,
        acknowledgedBy: null,
        status: 'open',
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

module.exports = {
  calculateNextRetryAt,
  getMaxRetries,
  upsertFailure,
  markSubmitted,
  resetForManualRetry,
  resetSourceDocumentStatus,
  createAbandonmentAlert,
  buildAttempt,
  normalizeError,
};
