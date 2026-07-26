/**
 * Maps Prisma invoice_receipt_metadata rows to the legacy Mongoose JSON shape
 * the invoice detail page and the EBM receipt endpoint read.
 */

const { generateObjectId, toIdString } = require('./objectId');
const { mapTimestamps } = require('./decimalHelpers');
const { mergeUpdatePayload } = require('./masterDataMappers');

function invoiceReceiptMetadataToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    company: row.companyId,
    invoice: row.invoiceId,
    sdcId: row.sdcId ?? null,
    receiptNumber: row.receiptNumber ?? null,
    receiptSignature: row.receiptSignature ?? null,
    internalData: row.internalData ?? null,
    mrcCode: row.mrcCode ?? null,
    deviceId: row.deviceId ?? null,
    fiscalDate: row.fiscalDate ?? null,
    ...mapTimestamps(row),
  };
}

const TEXT_FIELDS = ['sdcId', 'receiptNumber', 'receiptSignature', 'internalData', 'mrcCode', 'deviceId'];

function invoiceReceiptMetadataTranslateCreate(data = {}) {
  const out = {
    id: toIdString(data._id || data.id) || generateObjectId(),
    companyId: toIdString(data.company ?? data.companyId ?? data.company_id),
    invoiceId: toIdString(data.invoice ?? data.invoiceId ?? data.invoice_id),
    fiscalDate: data.fiscalDate ? new Date(data.fiscalDate) : null,
  };
  for (const field of TEXT_FIELDS) {
    out[field] = data[field] == null ? null : String(data[field]);
  }
  return out;
}

function invoiceReceiptMetadataTranslateUpdate(update = {}) {
  const merged = mergeUpdatePayload(update);
  const out = {};
  for (const field of TEXT_FIELDS) {
    if (merged[field] !== undefined) out[field] = merged[field] == null ? null : String(merged[field]);
  }
  if (merged.fiscalDate !== undefined) {
    out.fiscalDate = merged.fiscalDate ? new Date(merged.fiscalDate) : null;
  }
  const invoice = merged.invoice ?? merged.invoiceId;
  if (invoice !== undefined) out.invoiceId = toIdString(invoice);
  return out;
}

module.exports = {
  invoiceReceiptMetadataToApi,
  invoiceReceiptMetadataTranslateCreate,
  invoiceReceiptMetadataTranslateUpdate,
};
