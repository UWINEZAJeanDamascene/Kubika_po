/**
 * InvoiceReceiptMetadata model — PostgreSQL (Prisma) backed.
 *
 * Holds the fiscal receipt details (SDC id, receipt number, signature) that the
 * EBM device returns for a confirmed invoice.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  invoiceReceiptMetadataToApi,
  invoiceReceiptMetadataTranslateCreate,
  invoiceReceiptMetadataTranslateUpdate,
} = require('../utils/invoiceReceiptMappers');

const FIELD_MAP = {
  invoice: { target: 'invoiceId', isId: true },
  invoiceId: { target: 'invoiceId', isId: true },
  sdcId: { target: 'sdcId' },
  receiptNumber: { target: 'receiptNumber' },
  receiptSignature: { target: 'receiptSignature' },
  internalData: { target: 'internalData' },
  mrcCode: { target: 'mrcCode' },
  deviceId: { target: 'deviceId' },
  fiscalDate: { target: 'fiscalDate' },
};

module.exports = buildTenantModel({
  name: 'InvoiceReceiptMetadata',
  collection: 'invoicereceiptmetadatas',
  delegateName: 'invoiceReceiptMetadata',
  fieldMap: FIELD_MAP,
  toApi: invoiceReceiptMetadataToApi,
  translateCreate: invoiceReceiptMetadataTranslateCreate,
  translateUpdate: invoiceReceiptMetadataTranslateUpdate,
  mutable: true,
});
