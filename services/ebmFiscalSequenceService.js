const {
  MAX_VSDC_NUMBER,
  allocateEbmSequence,
  seedEbmSequence,
} = require('./postgresSequenceStore');

const EBM_SEQUENCE_TYPES = Object.freeze({
  SALES_INVOICE: 'sales_invoice',
  RECEIPT: 'receipt',
  REPORT: 'report',
  STOCK_SAR: 'stock_sar',
});

function normalizeBranchId(value) {
  if (value === undefined || value === null || value === '') return '00';
  return String(value).trim().padStart(2, '0').slice(-2);
}

function toPositiveInteger(value, fallback = null) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, MAX_VSDC_NUMBER);
}

async function allocate(companyId, branchId, sequenceType, options = {}) {
  const seed = toPositiveInteger(options.seed, 0) || 0;
  return allocateEbmSequence(companyId, normalizeBranchId(branchId), sequenceType, {
    seed,
    seededFrom: options.seededFrom || null,
    tx: options.tx || null,
  });
}

async function seedFromInitInfo(companyId, branchId, initInfo = {}) {
  const normalizedBranchId = normalizeBranchId(branchId);
  const salesInvoiceSeed = Math.max(
    toPositiveInteger(initInfo.lastSaleInvcNo, 0) || 0,
    toPositiveInteger(initInfo.lastInvcNo, 0) || 0,
  );
  const receiptSeed = toPositiveInteger(initInfo.lastSaleRcptNo, 0) || 0;

  const seeds = [
    [EBM_SEQUENCE_TYPES.SALES_INVOICE, salesInvoiceSeed],
    [EBM_SEQUENCE_TYPES.RECEIPT, receiptSeed],
    [EBM_SEQUENCE_TYPES.REPORT, receiptSeed],
  ].filter(([, seed]) => seed > 0);

  await Promise.all(
    seeds.map(([sequenceType, seed]) =>
      seedEbmSequence(companyId, normalizedBranchId, sequenceType, seed, 'vsdc_init'),
    ),
  );
}

function getFiscalField(doc, field) {
  return toPositiveInteger(doc?.ebm?.[field], null);
}

async function ensureSalesNumbers(doc, companyId, branchId, persist) {
  const updates = {};
  const invcNo =
    getFiscalField(doc, 'invcNo') ||
    (await allocate(companyId, branchId, EBM_SEQUENCE_TYPES.SALES_INVOICE));
  const curRcptNo =
    getFiscalField(doc, 'curRcptNo') ||
    (await allocate(companyId, branchId, EBM_SEQUENCE_TYPES.RECEIPT));
  const totRcptNo = getFiscalField(doc, 'totRcptNo') || curRcptNo;
  const rptNo =
    getFiscalField(doc, 'rptNo') ||
    (await allocate(companyId, branchId, EBM_SEQUENCE_TYPES.REPORT));

  if (getFiscalField(doc, 'invcNo') !== invcNo) updates['ebm.invcNo'] = invcNo;
  if (getFiscalField(doc, 'curRcptNo') !== curRcptNo) updates['ebm.curRcptNo'] = curRcptNo;
  if (getFiscalField(doc, 'totRcptNo') !== totRcptNo) updates['ebm.totRcptNo'] = totRcptNo;
  if (getFiscalField(doc, 'rptNo') !== rptNo) updates['ebm.rptNo'] = rptNo;

  if (Object.keys(updates).length && typeof persist === 'function') {
    await persist(updates);
    doc.ebm = doc.ebm || {};
    Object.entries(updates).forEach(([path, value]) => {
      doc.ebm[path.replace('ebm.', '')] = value;
    });
  }

  return { invcNo, curRcptNo, totRcptNo, rptNo };
}

async function ensureStockSarNumber(doc, companyId, branchId, persist, field = 'sarNo') {
  const existing = getFiscalField(doc, field);
  if (existing) return existing;
  const sarNo = await allocate(companyId, branchId, EBM_SEQUENCE_TYPES.STOCK_SAR);
  if (typeof persist === 'function') {
    await persist({ [`ebm.${field}`]: sarNo });
    doc.ebm = doc.ebm || {};
    doc.ebm[field] = sarNo;
  }
  return sarNo;
}

module.exports = {
  EBM_SEQUENCE_TYPES,
  MAX_VSDC_NUMBER,
  normalizeBranchId,
  allocate,
  seedFromInitInfo,
  ensureSalesNumbers,
  ensureStockSarNumber,
  toPositiveInteger,
};
