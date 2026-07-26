/**
 * Supplier model — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  supplierToApi,
  supplierTranslateCreate,
  supplierTranslateUpdate,
} = require('../utils/masterDataMappers');

const FIELD_MAP = {
  name: { target: 'name' },
  code: { target: 'code', transform: (v) => ({ code: typeof v === 'string' ? v.toUpperCase() : v }) },
  contact: { target: 'contact' },
  region: { target: 'region' },
  currency: { target: 'currency' },
  leadTime: { target: 'leadTime' },
  minimumOrder: { target: 'minimumOrder' },
  bankName: { target: 'bankName' },
  bankAccount: { target: 'bankAccount' },
  productsSupplied: { target: 'productsSupplied' },
  paymentTerms: { target: 'paymentTerms' },
  taxId: { target: 'taxId' },
  notes: { target: 'notes' },
  totalPurchases: { target: 'totalPurchases' },
  lastPurchaseDate: { target: 'lastPurchaseDate' },
  customFields: { target: 'customFields' },
};

module.exports = buildTenantModel({
  name: 'Supplier',
  collection: 'suppliers',
  delegateName: 'supplier',
  fieldMap: FIELD_MAP,
  toApi: supplierToApi,
  translateCreate: supplierTranslateCreate,
  translateUpdate: supplierTranslateUpdate,
  mutable: true,
});
