const EBMSequence = require('../models/EBMSequence');
const { EBM_SEQUENCE_TYPES } = require('../models/EBMSequence');

const MAX_VSDC_NUMBER = 9999999999;

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
  const normalizedBranchId = normalizeBranchId(branchId);
  const seed = toPositiveInteger(options.seed, 0) || 0;
  const filter = {
    company: companyId,
    branchId: normalizedBranchId,
    sequenceType,
  };

  try {
    await EBMSequence.findOneAndUpdate(
      filter,
      {
        $setOnInsert: {
          ...filter,
          lastNumber: seed,
          seededFrom: options.seededFrom || null,
          seededAt: seed ? new Date() : null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }

  const sequence = await EBMSequence.findOneAndUpdate(
    filter,
    { $inc: { lastNumber: 1 } },
    { new: true },
  ).lean();

  if (!sequence || sequence.lastNumber > MAX_VSDC_NUMBER) {
    const error = new Error(
      `EBM ${sequenceType} fiscal sequence exceeded VSDC NUMBER(10) capacity for branch ${normalizedBranchId}.`,
    );
    error.code = 'EBM_FISCAL_SEQUENCE_EXHAUSTED';
    error.retryable = false;
    throw error;
  }

  return sequence.lastNumber;
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

  await Promise.all(seeds.map(([sequenceType, seed]) =>
    EBMSequence.findOneAndUpdate(
      { company: companyId, branchId: normalizedBranchId, sequenceType },
      {
        $max: { lastNumber: seed },
        $set: {
          seededFrom: 'vsdc_init',
          seededAt: new Date(),
        },
        $setOnInsert: {
          company: companyId,
          branchId: normalizedBranchId,
          sequenceType,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ),
  ));
}

function getFiscalField(doc, field) {
  return toPositiveInteger(doc?.ebm?.[field], null);
}

async function ensureSalesNumbers(doc, companyId, branchId, persist) {
  const updates = {};
  const invcNo = getFiscalField(doc, 'invcNo') ||
    await allocate(companyId, branchId, EBM_SEQUENCE_TYPES.SALES_INVOICE);
  const curRcptNo = getFiscalField(doc, 'curRcptNo') ||
    await allocate(companyId, branchId, EBM_SEQUENCE_TYPES.RECEIPT);
  const totRcptNo = getFiscalField(doc, 'totRcptNo') || curRcptNo;
  const rptNo = getFiscalField(doc, 'rptNo') ||
    await allocate(companyId, branchId, EBM_SEQUENCE_TYPES.REPORT);

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
