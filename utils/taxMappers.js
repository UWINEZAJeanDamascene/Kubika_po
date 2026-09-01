/**
 * Mongo <-> Prisma mappers for TaxTransaction.
 *
 * Preserves the legacy document shape (nested `period`, populated refs) that
 * taxTransactionService and reporting endpoints consume.
 */

const { generateObjectId, toIdString } = require('./objectId');
const { decimalToNumber, decimalToString, mapTimestamps } = require('./decimalHelpers');
const { mergeUpdatePayload } = require('./masterDataMappers');

const moneyStr = (v) => decimalToString(v, 4);

function journalEntryRef(entry) {
  if (!entry) return null;
  return {
    _id: entry.id,
    id: entry.id,
    entryNumber: entry.entryNumber,
    date: entry.date,
    description: entry.description ?? null,
  };
}

function taxRateRef(rate) {
  if (!rate) return null;
  return {
    _id: rate.id,
    id: rate.id,
    name: rate.name,
    code: rate.code,
    rate_pct: rate.ratePct,
    ratePct: rate.ratePct,
  };
}

function taxTransactionToApi(row) {
  if (!row) return null;

  const period =
    row.periodMonth != null && row.periodYear != null
      ? { month: row.periodMonth, year: row.periodYear }
      : row.period ?? null;

  return {
    _id: row.id,
    id: row.id,
    company: row.companyId,
    companyId: row.companyId,
    taxType: row.taxType,
    direction: row.direction,
    amount: decimalToNumber(row.amount),
    netAmount: decimalToNumber(row.netAmount),
    grossAmount: decimalToNumber(row.grossAmount),
    taxRate: row.taxRate ?? 0,
    sourceType: row.sourceType,
    sourceId: row.sourceId ?? null,
    sourceReference: row.sourceReference ?? null,
    journalEntryId: row.journalEntry
      ? journalEntryRef(row.journalEntry)
      : row.journalEntryId ?? null,
    journalEntryNumber: row.journalEntryNumber ?? null,
    accountCode: row.accountCode,
    taxRateId: row.linkedTaxRate ? taxRateRef(row.linkedTaxRate) : row.taxRateId ?? null,
    taxCode: row.taxCode ?? null,
    period,
    date: row.date,
    description: row.description ?? null,
    status: row.status,
    reversalOf: row.reversalOfId ?? null,
    createdBy: row.createdById ?? null,
    metadata: row.metadata ?? {},
    isVAT: ['vat_input', 'vat_output', 'vat_input_reversed', 'vat_output_reversed'].includes(row.taxType),
    isPayroll: ['paye', 'rssb_employee', 'rssb_employer'].includes(row.taxType),
    ...mapTimestamps(row),
  };
}

const TAX_TRANSACTION_FIELD_MAP = {
  taxType: { target: 'taxType' },
  direction: { target: 'direction' },
  amount: { target: 'amount' },
  netAmount: { target: 'netAmount' },
  grossAmount: { target: 'grossAmount' },
  taxRate: { target: 'taxRate' },
  sourceType: { target: 'sourceType' },
  sourceId: { target: 'sourceId', isId: true },
  sourceReference: { target: 'sourceReference' },
  journalEntryId: { target: 'journalEntryId', isId: true },
  journalEntryNumber: { target: 'journalEntryNumber' },
  accountCode: { target: 'accountCode' },
  taxRateId: { target: 'taxRateId', isId: true },
  taxCode: { target: 'taxCode' },
  date: { target: 'date' },
  description: { target: 'description' },
  status: { target: 'status' },
  reversalOf: { target: 'reversalOfId', isId: true },
  metadata: { target: 'metadata' },
};

function resolvePeriod(data) {
  if (data.period && typeof data.period === 'object') {
    return {
      periodMonth: data.period.month ?? null,
      periodYear: data.period.year ?? null,
    };
  }
  const out = {};
  if (data.periodMonth !== undefined) out.periodMonth = data.periodMonth;
  if (data.periodYear !== undefined) out.periodYear = data.periodYear;
  return out;
}

function taxTransactionTranslateCreate(data = {}) {
  const companyId = toIdString(data.company || data.companyId || data.company_id);
  const createdById = data.createdBy ? toIdString(data.createdBy) : null;
  const journalEntryId = data.journalEntryId ? toIdString(data.journalEntryId) : null;
  const taxRateId = data.taxRateId ? toIdString(data.taxRateId) : null;
  const sourceId = data.sourceId ? toIdString(data.sourceId) : null;
  const reversalOfId = data.reversalOf ? toIdString(data.reversalOf) : null;

  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    companyId,
    taxType: String(data.taxType),
    direction: String(data.direction),
    amount: moneyStr(data.amount ?? 0),
    netAmount: moneyStr(data.netAmount ?? 0),
    grossAmount: moneyStr(data.grossAmount ?? 0),
    taxRate: Number(data.taxRate) || 0,
    sourceType: String(data.sourceType),
    sourceId,
    sourceReference: data.sourceReference ?? null,
    journalEntryId,
    journalEntryNumber: data.journalEntryNumber ?? null,
    accountCode: String(data.accountCode),
    taxRateId,
    taxCode: data.taxCode ?? null,
    ...resolvePeriod(data),
    date: data.date ? new Date(data.date) : new Date(),
    description: data.description ?? null,
    status: data.status || 'posted',
    reversalOfId,
    createdById,
    metadata: data.metadata ?? {},
    createdAt: data.createdAt || undefined,
    updatedAt: data.updatedAt || undefined,
  };
}

function taxTransactionTranslateUpdate(update = {}) {
  const merged = mergeUpdatePayload(update);
  const out = {};

  for (const [key, field] of Object.entries(TAX_TRANSACTION_FIELD_MAP)) {
    if (merged[key] !== undefined) {
      out[field.target] = field.isId ? toIdString(merged[key]) : merged[key];
    }
  }

  if (merged.company !== undefined || merged.companyId !== undefined) {
    out.companyId = toIdString(merged.company ?? merged.companyId);
  }
  if (merged.createdBy !== undefined) {
    out.createdById = merged.createdBy ? toIdString(merged.createdBy) : null;
  }
  if (merged.amount !== undefined) out.amount = moneyStr(merged.amount);
  if (merged.netAmount !== undefined) out.netAmount = moneyStr(merged.netAmount);
  if (merged.grossAmount !== undefined) out.grossAmount = moneyStr(merged.grossAmount);
  Object.assign(out, resolvePeriod(merged));

  return out;
}

function taxTransactionInclude(populate = []) {
  const paths = (populate || []).map((p) => String(p.path || p || ''));
  const include = {};
  if (paths.some((p) => p === 'journalEntryId' || p === 'journalEntry')) {
    include.journalEntry = {
      select: { id: true, entryNumber: true, date: true, description: true },
    };
  }
  if (paths.some((p) => p === 'taxRateId' || p === 'taxRate')) {
    include.linkedTaxRate = {
      select: { id: true, name: true, code: true, ratePct: true },
    };
  }
  return Object.keys(include).length ? include : undefined;
}

const TAX_TRANSACTION_DEFAULT_INCLUDE = {
  journalEntry: {
    select: { id: true, entryNumber: true, date: true, description: true },
  },
  linkedTaxRate: {
    select: { id: true, name: true, code: true, ratePct: true },
  },
};

module.exports = {
  TAX_TRANSACTION_FIELD_MAP,
  taxTransactionToApi,
  taxTransactionTranslateCreate,
  taxTransactionTranslateUpdate,
  taxTransactionInclude,
  TAX_TRANSACTION_DEFAULT_INCLUDE,
};
