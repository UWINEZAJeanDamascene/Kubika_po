/**
 * Mongo <-> Prisma mappers for the AR and AP transaction ledgers.
 *
 * Both are append-only audit trails, so the mapping is mostly mechanical. Two
 * things need care:
 *
 *  - **Decimals.** Prisma returns Decimal objects. Callers compare and sum these
 *    (`balance - amount`, `Math.abs(a - b) > 0.01`), which silently misbehaves
 *    against an object, so every money column is converted to a number on read.
 *  - **The `signedAmount` virtual.** Mongo exposed it via schema virtuals; it is
 *    computed here instead, because a plain Prisma row has no virtuals.
 */

const { generateObjectId } = require('./objectId');
const { decimalToNumber } = require('./decimalHelpers');

const idOrNull = (v) => (v == null ? null : String(v._id || v.id || v));

/** Ledger rows are immutable in practice, but updates must still map cleanly. */
function pickDefined(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

// ── AR ──────────────────────────────────────────────────────────────────

const AR_FIELD_MAP = {
  client: { target: 'clientId', isId: true },
  clientId: { target: 'clientId', isId: true },
  invoice: { target: 'invoiceId', isId: true },
  invoiceId: { target: 'invoiceId', isId: true },
  receipt: { target: 'receiptId', isId: true },
  receiptId: { target: 'receiptId', isId: true },
  transactionType: { target: 'transactionType' },
  transactionDate: { target: 'transactionDate' },
  referenceNo: { target: 'referenceNo' },
  description: { target: 'description' },
  amount: { target: 'amount' },
  direction: { target: 'direction' },
  invoiceBalanceAfter: { target: 'invoiceBalanceAfter' },
  clientBalanceAfter: { target: 'clientBalanceAfter' },
  sourceType: { target: 'sourceType' },
  sourceId: { target: 'sourceId', isId: true },
  sourceReference: { target: 'sourceReference' },
  journalEntryId: { target: 'journalEntryId', isId: true },
  reconciliationStatus: { target: 'reconciliationStatus' },
  reversedFrom: { target: 'reversedFrom', isId: true },
  reversedBy: { target: 'reversedBy', isId: true },
  fiscalYear: { target: 'fiscalYear' },
  accountingPeriod: { target: 'accountingPeriod' },
};

function arLedgerToApi(row) {
  if (!row) return row;
  const amount = decimalToNumber(row.amount);
  return {
    _id: row.id,
    id: row.id,
    company: row.companyId,
    client: row.clientId,
    invoice: row.invoiceId ?? null,
    receipt: row.receiptId ?? null,
    transactionType: row.transactionType,
    transactionDate: row.transactionDate,
    referenceNo: row.referenceNo ?? null,
    description: row.description,
    amount,
    direction: row.direction,
    // Was a Mongoose virtual; recomputed here.
    signedAmount: row.direction === 'decrease' ? -amount : amount,
    invoiceBalanceAfter: row.invoiceBalanceAfter == null ? null : decimalToNumber(row.invoiceBalanceAfter),
    clientBalanceAfter: row.clientBalanceAfter == null ? null : decimalToNumber(row.clientBalanceAfter),
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    sourceReference: row.sourceReference ?? null,
    journalEntryId: row.journalEntryId ?? null,
    metadata: row.metadata ?? {},
    reconciliationStatus: row.reconciliationStatus,
    discrepancyDetails: row.discrepancyDetails ?? null,
    createdBy: row.createdById ?? null,
    reversedFrom: row.reversedFrom ?? null,
    reversedBy: row.reversedBy ?? null,
    fiscalYear: row.fiscalYear ?? null,
    accountingPeriod: row.accountingPeriod ?? null,
    ipAddress: row.ipAddress ?? null,
    userAgent: row.userAgent ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function arLedgerTranslateCreate(data = {}) {
  const now = new Date();
  return {
    id: data._id ? String(data._id) : generateObjectId(),
    companyId: idOrNull(data.company ?? data.companyId),
    clientId: idOrNull(data.client ?? data.clientId),
    invoiceId: idOrNull(data.invoice ?? data.invoiceId),
    receiptId: idOrNull(data.receipt ?? data.receiptId),
    transactionType: data.transactionType,
    transactionDate: data.transactionDate ? new Date(data.transactionDate) : now,
    referenceNo: data.referenceNo ?? null,
    description: data.description,
    amount: data.amount,
    direction: data.direction,
    invoiceBalanceAfter: data.invoiceBalanceAfter ?? null,
    clientBalanceAfter: data.clientBalanceAfter ?? null,
    sourceType: data.sourceType,
    sourceId: idOrNull(data.sourceId),
    sourceReference: data.sourceReference ?? null,
    journalEntryId: idOrNull(data.journalEntryId),
    metadata: data.metadata ?? undefined,
    reconciliationStatus: data.reconciliationStatus || 'pending',
    discrepancyDetails: data.discrepancyDetails ?? undefined,
    createdById: idOrNull(data.createdBy ?? data.createdById),
    reversedFrom: idOrNull(data.reversedFrom),
    reversedBy: idOrNull(data.reversedBy),
    // Mongoose computed these with default functions; do the same on write.
    fiscalYear: data.fiscalYear ?? (data.transactionDate ? new Date(data.transactionDate) : now).getFullYear(),
    accountingPeriod:
      data.accountingPeriod
      ?? `${(data.transactionDate ? new Date(data.transactionDate) : now).getFullYear()}-${String((data.transactionDate ? new Date(data.transactionDate) : now).getMonth() + 1).padStart(2, '0')}`,
    ipAddress: data.ipAddress ?? null,
    userAgent: data.userAgent ?? null,
  };
}

const AR_UPDATABLE = [
  'transactionType', 'transactionDate', 'referenceNo', 'description', 'amount',
  'direction', 'invoiceBalanceAfter', 'clientBalanceAfter', 'sourceType',
  'sourceReference', 'metadata', 'reconciliationStatus', 'discrepancyDetails',
  'fiscalYear', 'accountingPeriod', 'ipAddress', 'userAgent',
];

function arLedgerTranslateUpdate(update = {}) {
  const set = update.$set || update;
  const out = pickDefined(set, AR_UPDATABLE);
  if (set.reversedBy !== undefined) out.reversedBy = idOrNull(set.reversedBy);
  if (set.reversedFrom !== undefined) out.reversedFrom = idOrNull(set.reversedFrom);
  if (set.journalEntryId !== undefined) out.journalEntryId = idOrNull(set.journalEntryId);
  return out;
}

// ── AP ──────────────────────────────────────────────────────────────────

const AP_FIELD_MAP = {
  supplier: { target: 'supplierId', isId: true },
  supplierId: { target: 'supplierId', isId: true },
  grn: { target: 'grnId', isId: true },
  grnId: { target: 'grnId', isId: true },
  payment: { target: 'paymentId', isId: true },
  paymentId: { target: 'paymentId', isId: true },
  transactionType: { target: 'transactionType' },
  transactionDate: { target: 'transactionDate' },
  referenceNo: { target: 'referenceNo' },
  description: { target: 'description' },
  amount: { target: 'amount' },
  direction: { target: 'direction' },
  supplierBalanceAfter: { target: 'supplierBalanceAfter' },
  grnBalanceAfter: { target: 'grnBalanceAfter' },
  sourceType: { target: 'sourceType' },
  sourceId: { target: 'sourceId', isId: true },
  sourceReference: { target: 'sourceReference' },
  reconciliationStatus: { target: 'reconciliationStatus' },
  verifiedAt: { target: 'verifiedAt' },
};

function apLedgerToApi(row) {
  if (!row) return row;
  const amount = decimalToNumber(row.amount);
  return {
    _id: row.id,
    id: row.id,
    company: row.companyId,
    supplier: row.supplierId,
    transactionType: row.transactionType,
    transactionDate: row.transactionDate,
    referenceNo: row.referenceNo ?? null,
    description: row.description,
    amount,
    direction: row.direction,
    signedAmount: row.direction === 'decrease' ? -amount : amount,
    supplierBalanceAfter: row.supplierBalanceAfter == null ? null : decimalToNumber(row.supplierBalanceAfter),
    grnBalanceAfter: row.grnBalanceAfter == null ? null : decimalToNumber(row.grnBalanceAfter),
    grn: row.grnId ?? null,
    payment: row.paymentId ?? null,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    sourceReference: row.sourceReference ?? null,
    createdBy: row.createdById ?? null,
    reconciliationStatus: row.reconciliationStatus,
    verifiedAt: row.verifiedAt ?? null,
    discrepancyDetails: row.discrepancyDetails ?? null,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function apLedgerTranslateCreate(data = {}) {
  const now = new Date();
  return {
    id: data._id ? String(data._id) : generateObjectId(),
    companyId: idOrNull(data.company ?? data.companyId),
    supplierId: idOrNull(data.supplier ?? data.supplierId),
    transactionType: data.transactionType,
    transactionDate: data.transactionDate ? new Date(data.transactionDate) : now,
    referenceNo: data.referenceNo ?? null,
    description: data.description,
    amount: data.amount,
    direction: data.direction,
    supplierBalanceAfter: data.supplierBalanceAfter ?? null,
    grnBalanceAfter: data.grnBalanceAfter ?? null,
    grnId: idOrNull(data.grn ?? data.grnId),
    paymentId: idOrNull(data.payment ?? data.paymentId),
    sourceType: data.sourceType,
    sourceId: idOrNull(data.sourceId),
    sourceReference: data.sourceReference ?? null,
    createdById: idOrNull(data.createdBy ?? data.createdById),
    reconciliationStatus: data.reconciliationStatus || 'pending',
    verifiedAt: data.verifiedAt ?? null,
    discrepancyDetails: data.discrepancyDetails ?? undefined,
    metadata: data.metadata ?? undefined,
  };
}

const AP_UPDATABLE = [
  'transactionType', 'transactionDate', 'referenceNo', 'description', 'amount',
  'direction', 'supplierBalanceAfter', 'grnBalanceAfter', 'sourceType',
  'sourceReference', 'reconciliationStatus', 'verifiedAt', 'discrepancyDetails',
  'metadata',
];

function apLedgerTranslateUpdate(update = {}) {
  const set = update.$set || update;
  return pickDefined(set, AP_UPDATABLE);
}

module.exports = {
  AR_FIELD_MAP,
  arLedgerToApi,
  arLedgerTranslateCreate,
  arLedgerTranslateUpdate,
  AP_FIELD_MAP,
  apLedgerToApi,
  apLedgerTranslateCreate,
  apLedgerTranslateUpdate,
};
