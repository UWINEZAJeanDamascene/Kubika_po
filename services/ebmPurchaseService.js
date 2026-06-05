const Company = require('../models/Company');
const EBMDevice = require('../models/EBMDevice');
const EBMSyncState = require('../models/EBMSyncState');
const EBMUnmatchedPurchase = require('../models/EBMUnmatchedPurchase');
const PurchaseOrder = require('../models/PurchaseOrder');
const Purchase = require('../models/Purchase');
const Supplier = require('../models/Supplier');
const Warehouse = require('../models/Warehouse');
const ebmService = require('./ebmService');
const { EBM_DEVICE_STATUSES } = require('../models/EBMDevice');
const EBMQueueService = require('./ebmQueueService');
const { formatVsdcDate, formatVsdcDateTime, VSDC_ENDPOINTS } = require('./ebmService');

const FIRST_SYNC_DT = '20000101000000';
const SYNC_TYPE = 'purchase_sales';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeBranchId(value) {
  return String(value || '00').padStart(2, '0').slice(-2);
}

function toNumber(value, fallback = 0) {
  if (value == null) return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (value && typeof value.toString === 'function') {
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseVsdcDate(value) {
  if (!value) return null;
  const raw = String(value);
  if (/^\d{8}$/.test(raw)) return new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00Z`);
  if (/^\d{14}$/.test(raw)) return new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}Z`);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatPurchaseDate(...values) {
  for (const value of values) {
    if (!value) continue;
    const raw = String(value);
    if (/^\d{8}$/.test(raw)) return raw;
    if (/^\d{14}$/.test(raw)) return raw.slice(0, 8);
    const parsed = parseVsdcDate(value);
    if (parsed) return formatVsdcDate(parsed);
  }
  return formatVsdcDate();
}

function getTin(company) {
  return company?.tax_identification_number || company?.registration_number || company?.tin;
}

function roundRwf(value) {
  return Math.round(toNumber(value));
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function formatOptionalBarcode(value) {
  return value ? String(value).slice(0, 20) : '';
}

function formatOptionalExpiry(value) {
  if (!value) return null;
  const raw = String(value);
  if (/^\d{8}$/.test(raw)) return raw;
  if (/^\d{14}$/.test(raw)) return raw.slice(0, 8);
  const parsed = parseVsdcDate(value);
  return parsed ? formatVsdcDate(parsed) : null;
}

function buildPurchaseItemPayload(item, index) {
  const qty = toNumber(firstDefined(item.qty, item.quantity), 0);
  const prc = toNumber(firstDefined(item.prc, item.price, item.unitCost), 0);
  const dcAmt = roundRwf(firstDefined(item.dcAmt, item.discountAmount, item.discount, 0));
  const dcRt = toNumber(firstDefined(item.dcRt, item.discountRate, 0), 0);
  const splyAmt = roundRwf(firstDefined(item.splyAmt, item.supplyAmount, qty * prc));
  const taxTyCd = firstDefined(item.taxTyCd, item.taxTypeCode, item.taxCode, 'D');
  const taxblAmt = roundRwf(firstDefined(item.taxblAmt, item.taxableAmount, splyAmt - dcAmt));
  const taxAmt = roundRwf(firstDefined(item.taxAmt, item.taxAmount, 0));
  const totAmt = roundRwf(firstDefined(item.totAmt, item.totalAmount, item.totalWithTax, taxblAmt + taxAmt));

  return {
    itemSeq: toNumber(item.itemSeq, index + 1),
    itemCd: firstDefined(item.itemCd, item.itemCode, ''),
    itemClsCd: firstDefined(item.itemClsCd, item.itemClassCode),
    itemNm: firstDefined(item.itemNm, item.itemName, 'Item'),
    bcd: formatOptionalBarcode(firstDefined(item.bcd, item.barcode)),
    pkgUnitCd: firstDefined(item.pkgUnitCd, item.packagingUnitCode),
    pkg: toNumber(firstDefined(item.pkg, item.package, 1), 1),
    qtyUnitCd: firstDefined(item.qtyUnitCd, item.quantityUnitCode),
    qty,
    prc,
    splyAmt,
    dcRt,
    dcAmt,
    taxTyCd,
    taxblAmt,
    taxAmt,
    totAmt,
    itemExprDt: formatOptionalExpiry(firstDefined(item.itemExprDt, item.expiryDate)),
  };
}

function buildTaxBuckets(itemList) {
  const buckets = {
    A: { taxbl: 0, tax: 0 },
    B: { taxbl: 0, tax: 0 },
    C: { taxbl: 0, tax: 0 },
    D: { taxbl: 0, tax: 0 },
  };

  itemList.forEach((item) => {
    const code = buckets[item.taxTyCd] ? item.taxTyCd : 'D';
    buckets[code].taxbl += toNumber(item.taxblAmt);
    buckets[code].tax += toNumber(item.taxAmt);
  });

  return buckets;
}

async function getInitializedDevice(companyId, branchId) {
  const mode = ebmService.getConfig().mode;
  const device = await EBMDevice.findOne({
    company: companyId,
    branchId,
    status: EBM_DEVICE_STATUSES.INITIALIZED,
    initializedMode: mode,
  }).lean();
  if (!device) {
    const error = new Error(`EBM device is not initialized for branch ${branchId} in ${mode} mode.`);
    error.code = 'EBM_DEVICE_NOT_INITIALIZED';
    error.statusCode = 409;
    throw error;
  }
  return device;
}

async function getSyncState(companyId, branchId) {
  const mode = ebmService.getConfig().mode;
  return EBMSyncState.findOneAndUpdate(
    { company: companyId, branchId, syncType: SYNC_TYPE, mode },
    {
      $setOnInsert: { company: companyId, branchId, syncType: SYNC_TYPE, mode, lastReqDt: FIRST_SYNC_DT },
      $set: { lastAttemptAt: new Date() },
    },
    { upsert: true, new: true },
  );
}

function normalizePurchaseSale(raw, companyId, branchId) {
  const supplierTin = String(raw.spplrTin || raw.supplierTin || raw.splrTin || raw.sellerTin || '').trim();
  const sellerInvoiceNo = String(raw.spplrInvcNo || raw.supplierInvoiceNo || raw.invcNo || raw.salesInvcNo || raw.rcptNo || '').trim();
  const totalAmount = toNumber(raw.totAmt || raw.totalAmount || raw.grandTotal);
  const taxAmount = toNumber(raw.totTaxAmt || raw.taxAmount || raw.totalTax);
  return {
    company: companyId,
    branchId,
    supplierTin,
    supplierName: raw.spplrNm || raw.supplierName || raw.splrNm || null,
    sellerInvoiceNo,
    purchaseOrderCode: raw.prcOrdCd || raw.purchaseOrderCode || null,
    invoiceDate: parseVsdcDate(raw.pchsDt || raw.salesDt || raw.invcDt || raw.rcptDt),
    totalAmount,
    taxAmount,
    raw,
    pulledAt: new Date(),
  };
}

async function resolveBranchIdForDocument(doc, companyId, requestedBranchId = null) {
  if (requestedBranchId) return normalizeBranchId(requestedBranchId);
  const warehouseId = doc?.warehouse || doc?.branch || null;
  if (warehouseId) {
    const warehouse = await Warehouse.findOne({ _id: warehouseId, company: companyId }).lean();
    if (warehouse?.rraBranchId) return warehouse.rraBranchId;
  }
  const warehouse = await Warehouse.findOne({ company: companyId, isDefault: true }).lean()
    || await Warehouse.findOne({ company: companyId }).sort({ createdAt: 1 }).lean();
  return normalizeBranchId(warehouse?.rraBranchId || '00');
}

async function findMatchingDocument(companyId, purchaseSale) {
  const amountMin = purchaseSale.totalAmount ? purchaseSale.totalAmount - 1 : 0;
  const amountMax = purchaseSale.totalAmount ? purchaseSale.totalAmount + 1 : Number.MAX_SAFE_INTEGER;
  const supplier = purchaseSale.supplierTin
    ? await Supplier.findOne({ company: companyId, taxId: purchaseSale.supplierTin }).lean()
    : null;

  const poQuery = {
    company: companyId,
    'ebm.ebmPurchaseMatchStatus': { $in: [null, 'unmatched'] },
    ...(supplier ? { supplier: supplier._id } : {}),
    totalAmount: { $gte: amountMin, $lte: amountMax },
  };
  const po = await PurchaseOrder.findOne(poQuery).sort({ orderDate: -1 });
  if (po) return { type: 'PurchaseOrder', doc: po };

  const purchaseQuery = {
    company: companyId,
    'ebm.ebmPurchaseMatchStatus': { $in: [null, 'unmatched'] },
    ...(supplier ? { supplier: supplier._id } : {}),
    $or: [
      { supplierInvoiceNumber: purchaseSale.sellerInvoiceNo },
      { roundedAmount: { $gte: amountMin, $lte: amountMax } },
      { grandTotal: { $gte: amountMin, $lte: amountMax } },
      { total: { $gte: amountMin, $lte: amountMax } },
    ],
  };
  const purchase = await Purchase.findOne(purchaseQuery).sort({ purchaseDate: -1 });
  if (purchase) return { type: 'Purchase', doc: purchase };

  return null;
}

async function storeUnmatched(purchaseSale) {
  return EBMUnmatchedPurchase.findOneAndUpdate(
    {
      company: purchaseSale.company,
      branchId: purchaseSale.branchId,
      supplierTin: purchaseSale.supplierTin,
      sellerInvoiceNo: purchaseSale.sellerInvoiceNo,
    },
    {
      $set: purchaseSale,
      $setOnInsert: { status: 'unmatched' },
    },
    { upsert: true, new: true },
  );
}

async function markMatched(match, purchaseSale) {
  match.doc.ebm = match.doc.ebm || {};
  match.doc.ebm.ebmPurchaseData = purchaseSale.raw;
  match.doc.ebm.ebmPurchaseSalesInvcNo = purchaseSale.sellerInvoiceNo;
  match.doc.ebm.prcOrdCd = purchaseSale.purchaseOrderCode || purchaseSale.raw?.prcOrdCd || null;
  match.doc.ebm.ebmPurchaseMatchStatus = 'matched';
  match.doc.ebm.ebmStatus = 'pending';
  match.doc.ebm.lastError = null;
  await match.doc.save();
  await EBMUnmatchedPurchase.findOneAndUpdate(
    {
      company: purchaseSale.company,
      branchId: purchaseSale.branchId,
      supplierTin: purchaseSale.supplierTin,
      sellerInvoiceNo: purchaseSale.sellerInvoiceNo,
    },
    {
      $set: {
        ...purchaseSale,
        status: 'linked',
        linkedDocumentType: match.type,
        linkedDocument: match.doc._id,
      },
    },
    { upsert: true },
  );
  return match;
}

function buildPurchaseConfirmationPayload(doc, company, branchId) {
  const raw = doc.ebm?.ebmPurchaseData || {};
  const sellerInvoiceNo = doc.ebm?.ebmPurchaseSalesInvcNo || raw.spplrInvcNo || raw.invcNo;
  const itemList = asArray(raw.itemList || raw.items).map(buildPurchaseItemPayload);
  const buckets = buildTaxBuckets(itemList);
  const totTaxblAmt = roundRwf(itemList.reduce((sum, item) => sum + item.taxblAmt, 0));
  const totTaxAmt = roundRwf(itemList.reduce((sum, item) => sum + item.taxAmt, 0));
  const totAmt = roundRwf(itemList.reduce((sum, item) => sum + item.totAmt, 0))
    || roundRwf(raw.totAmt || raw.totalAmount || doc.totalAmount || doc.grandTotal || doc.roundedAmount);
  const operatorId = String(getTin(company) || 'system').slice(0, 20);
  const operatorName = String(company?.name || 'System').slice(0, 60);

  return {
    companyId: doc.company,
    tin: getTin(company),
    bhfId: branchId,
    spplrTin: raw.spplrTin || raw.supplierTin || raw.splrTin || raw.sellerTin,
    spplrNm: raw.spplrNm || raw.supplierName || raw.splrNm,
    spplrInvcNo: sellerInvoiceNo,
    prcOrdCd: String(raw.prcOrdCd || doc.ebm?.prcOrdCd || doc.purchaseOrderCode || doc.purchaseCode || '').slice(0, 5),
    invcNo: sellerInvoiceNo,
    orgInvcNo: raw.orgInvcNo || 0,
    spplrBhfId: raw.spplrBhfId || raw.supplierBranchId || '',
    regTyCd: raw.regTyCd || 'M',
    pchsTyCd: raw.pchsTyCd || raw.salesTyCd || 'N',
    rcptTyCd: raw.rcptTyCd || 'P',
    pmtTyCd: raw.pmtTyCd || '',
    pchsSttsCd: '02',
    cfmDt: formatVsdcDateTime(),
    pchsDt: formatPurchaseDate(raw.pchsDt, raw.salesDt, raw.invcDt, raw.rcptDt, doc.purchaseDate, doc.orderDate, doc.createdAt),
    wrhsDt: formatPurchaseDate(raw.wrhsDt, doc.receivedDate, doc.updatedAt),
    totItemCnt: itemList.length,
    taxblAmtA: roundRwf(buckets.A.taxbl),
    taxblAmtB: roundRwf(buckets.B.taxbl),
    taxblAmtC: roundRwf(buckets.C.taxbl),
    taxblAmtD: roundRwf(buckets.D.taxbl),
    taxRtA: 0,
    taxRtB: 0,
    taxRtC: 0,
    taxRtD: 0,
    taxAmtA: roundRwf(buckets.A.tax),
    taxAmtB: roundRwf(buckets.B.tax),
    taxAmtC: roundRwf(buckets.C.tax),
    taxAmtD: roundRwf(buckets.D.tax),
    totTaxblAmt,
    totTaxAmt,
    totAmt,
    remark: `Confirmed from ${doc.referenceNo || doc.purchaseNumber || doc._id}`,
    regrId: operatorId,
    regrNm: operatorName,
    modrId: operatorId,
    modrNm: operatorName,
    itemList,
  };
}

async function confirmMatchedDocument(doc, type, branchId = null) {
  if (!doc || doc.ebm?.ebmPurchaseMatchStatus !== 'matched') return doc;
  const company = await Company.findById(doc.company).lean();
  const resolvedBranchId = normalizeBranchId(branchId || await resolveBranchIdForDocument(doc, doc.company));
  const payload = buildPurchaseConfirmationPayload(doc, company, resolvedBranchId);

  try {
    await ebmService.savePurchases(payload);
    doc.ebm.purchaseConfirmationPayload = payload;
    doc.ebm.ebmPurchaseMatchStatus = 'confirmed';
    doc.ebm.ebmConfirmedAt = new Date();
    doc.ebm.ebmStatus = 'submitted';
    doc.ebm.submittedAt = new Date();
    doc.ebm.lastError = null;
    await doc.save();
    await EBMQueueService.markSubmitted({
      companyId: doc.company,
      documentType: 'purchase',
      documentId: doc._id,
      endpoint: VSDC_ENDPOINTS.SAVE_PURCHASES,
    }).catch(() => {});
  } catch (error) {
    doc.ebm.ebmStatus = error.retryable === false ? 'failed' : 'pending';
    doc.ebm.lastError = error.message || 'EBM purchase confirmation failed';
    doc.ebm.retryCount = (doc.ebm.retryCount || 0) + 1;
    await doc.save();
    if (error.retryable !== false) {
      await EBMQueueService.upsertFailure({
        companyId: doc.company,
        documentType: 'purchase',
        documentId: doc._id,
        endpoint: VSDC_ENDPOINTS.SAVE_PURCHASES,
        payload,
        error,
      }).catch(() => {});
    }
  }
  return doc;
}

class EBMPurchaseService {
  static async syncPurchases(companyId, options = {}) {
    const branchId = normalizeBranchId(options.branchId || options.bhfId || '00');
    const full = options.full === true;
    const device = await getInitializedDevice(companyId, branchId);
    const state = await getSyncState(companyId, branchId);
    const lastReqDt = full ? FIRST_SYNC_DT : (state.lastReqDt || FIRST_SYNC_DT);

    try {
      const response = await ebmService.selectPurchaseSales({
        companyId,
        tin: device.tin,
        bhfId: branchId,
        lastReqDt,
        ...(options.prcOrdCd || options.purchaseOrderCode ? { prcOrdCd: options.prcOrdCd || options.purchaseOrderCode } : {}),
      });
      const sales = asArray(response.data?.saleList || response.data?.pchsList || response.data?.purchaseList);
      let matched = 0;
      let unmatched = 0;

      for (const raw of sales) {
        const normalized = normalizePurchaseSale(raw, companyId, branchId);
        if (!normalized.sellerInvoiceNo) continue;
        const match = await findMatchingDocument(companyId, normalized);
        if (match) {
          await markMatched(match, normalized);
          matched += 1;
        } else {
          await storeUnmatched(normalized);
          unmatched += 1;
        }
      }

      state.lastReqDt = response.resultDt || formatVsdcDateTime();
      state.lastSuccessfulSyncAt = new Date();
      state.lastErrorMessage = null;
      state.summary = { syncType: SYNC_TYPE, lastReqDt, received: sales.length, matched, unmatched };
      await state.save();
      return { branchId, mode: ebmService.getConfig().mode, ...state.summary, resultDt: response.resultDt };
    } catch (error) {
      state.lastErrorMessage = error.message || 'Purchase sync failed';
      await state.save();
      throw error;
    }
  }

  static async processPurchaseDocument(companyId, doc, type, options = {}) {
    const branchId = normalizeBranchId(options.branchId || await resolveBranchIdForDocument(doc, companyId));
    try {
      await this.syncPurchases(companyId, {
        branchId,
        prcOrdCd: doc.referenceNo || doc.purchaseNumber || doc.purchaseCode || String(doc._id),
      });
      const Model = type === 'Purchase' ? Purchase : PurchaseOrder;
      const refreshed = await Model.findOne({ _id: doc._id, company: companyId });
      if (refreshed?.ebm?.ebmPurchaseMatchStatus === 'matched') {
        return confirmMatchedDocument(refreshed, type, branchId);
      }
      return refreshed || doc;
    } catch (error) {
      const target = doc;
      target.ebm = target.ebm || {};
      target.ebm.ebmPurchaseMatchStatus = target.ebm.ebmPurchaseMatchStatus || 'unmatched';
      target.ebm.ebmStatus = error.retryable === false ? 'failed' : 'pending';
      target.ebm.lastError = error.message || 'EBM purchase pull failed';
      target.ebm.retryCount = (target.ebm.retryCount || 0) + 1;
      await target.save().catch(() => {});
      console.error('[EBMPurchase] Purchase EBM processing failed:', error.message);
      return target;
    }
  }

  static async listUnmatched(companyId, query = {}) {
    const filter = { company: companyId };
    if (query.status) filter.status = query.status;
    return EBMUnmatchedPurchase.find(filter)
      .sort({ pulledAt: -1, createdAt: -1 })
      .limit(Math.min(Number(query.limit || 100), 500))
      .lean();
  }

  static async syncDueCompanies() {
    const intervalHours = Math.max(1, Number(process.env.EBM_PURCHASE_SYNC_INTERVAL_HOURS || 6));
    const dueBefore = new Date(Date.now() - intervalHours * 60 * 60 * 1000);
    const devices = await EBMDevice.find({
      status: EBM_DEVICE_STATUSES.INITIALIZED,
      initializedMode: ebmService.getConfig().mode,
    }).lean();
    const summary = [];
    for (const device of devices) {
      const state = await EBMSyncState.findOne({
        company: device.company,
        branchId: device.branchId,
        syncType: SYNC_TYPE,
        mode: ebmService.getConfig().mode,
      }).lean();
      if (state?.lastSuccessfulSyncAt && state.lastSuccessfulSyncAt > dueBefore) continue;
      try {
        summary.push(await this.syncPurchases(device.company, { branchId: device.branchId }));
      } catch (error) {
        summary.push({ company: device.company, branchId: device.branchId, error: error.message });
      }
    }
    return summary;
  }
}

module.exports = EBMPurchaseService;
module.exports.__test__ = {
  buildPurchaseConfirmationPayload,
  buildPurchaseItemPayload,
};
