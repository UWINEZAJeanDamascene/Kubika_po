const VSDC_ENDPOINTS = Object.freeze({
  SAVE_SALES: '/transactions/saveSales',
  SAVE_PURCHASES: '/transactions/savePurchases',
  SAVE_STOCK_ITEMS: '/stock/saveStockItems',
  SAVE_STOCK_MASTER: '/stock/saveStockMaster',
  SELECT_CUSTOMER: '/customers/selectCustomer',
});

const INTERNAL_FIELDS = new Set([
  'companyId',
  'company_id',
  'company',
  'branchId',
]);

const ENDPOINT_STRIP_FIELDS = Object.freeze({
  [VSDC_ENDPOINTS.SAVE_SALES]: new Set(['orgRcptNo']),
  [VSDC_ENDPOINTS.SAVE_PURCHASES]: new Set(['spplrInvcNo']),
  [VSDC_ENDPOINTS.SELECT_CUSTOMER]: new Set(['lastReqDt']),
});

const SALES_NUMERIC_FIELDS = new Set([
  'invcNo',
  'orgInvcNo',
  'totItemCnt',
  'taxblAmtA',
  'taxblAmtB',
  'taxblAmtC',
  'taxblAmtD',
  'taxRtA',
  'taxRtB',
  'taxRtC',
  'taxRtD',
  'taxAmtA',
  'taxAmtB',
  'taxAmtC',
  'taxAmtD',
  'totTaxblAmt',
  'totTaxAmt',
  'totAmt',
]);

const SALES_RECEIPT_NUMERIC_FIELDS = new Set([
  'curRcptNo',
  'totRcptNo',
  'rptNo',
  'totItemCnt',
]);

const SALES_LINE_NUMERIC_FIELDS = new Set([
  'itemSeq',
  'pkg',
  'qty',
  'prc',
  'splyAmt',
  'dcRt',
  'dcAmt',
  'isrcRt',
  'isrcAmt',
  'taxblAmt',
  'taxAmt',
  'totAmt',
]);

const PURCHASE_NUMERIC_FIELDS = new Set([
  ...SALES_NUMERIC_FIELDS,
  'itemSeq',
]);

const STOCK_HEADER_NUMERIC_FIELDS = new Set([
  'sarNo',
  'orgSarNo',
  'totItemCnt',
  'totTaxblAmt',
  'totTaxAmt',
  'totAmt',
]);

const STOCK_LINE_NUMERIC_FIELDS = new Set([
  'itemSeq',
  'pkg',
  'qty',
  'prc',
  'splyAmt',
  'totDcAmt',
  'taxblAmt',
  'taxAmt',
  'totAmt',
]);

function toVsdcNumber(value) {
  if (value === null || value === undefined || value === '') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function normalizeNumericObject(source, numericFields) {
  if (!source || typeof source !== 'object') return source;
  const next = { ...source };
  numericFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(next, field)) {
      next[field] = toVsdcNumber(next[field]);
    }
  });
  return next;
}

function sanitizeStockItemLine(line) {
  if (!line || typeof line !== 'object') return line;
  const next = normalizeNumericObject(line, STOCK_LINE_NUMERIC_FIELDS);
  delete next.bhfTinTyCd;
  return next;
}

function sanitizeSalesPayload(payload) {
  const next = normalizeNumericObject({ ...payload }, SALES_NUMERIC_FIELDS);
  if (next.receipt && typeof next.receipt === 'object') {
    next.receipt = normalizeNumericObject(next.receipt, SALES_RECEIPT_NUMERIC_FIELDS);
  }
  if (Array.isArray(next.itemList)) {
    next.itemList = next.itemList.map((line) => normalizeNumericObject(line, SALES_LINE_NUMERIC_FIELDS));
  }
  return next;
}

function sanitizePurchasePayload(payload) {
  const next = normalizeNumericObject({ ...payload }, SALES_NUMERIC_FIELDS);
  if (Array.isArray(next.itemList)) {
    next.itemList = next.itemList.map((line) => normalizeNumericObject(line, SALES_LINE_NUMERIC_FIELDS));
  }
  return next;
}

function sanitizeStockPayload(payload) {
  const next = normalizeNumericObject({ ...payload }, STOCK_HEADER_NUMERIC_FIELDS);
  if (Array.isArray(next.itemList)) {
    next.itemList = next.itemList.map((line) => sanitizeStockItemLine(line));
  }
  return next;
}

function sanitizeSaveStockMasterPayload(payload) {
  const next = { ...payload };
  if (Object.prototype.hasOwnProperty.call(next, 'rsdQty')) {
    next.rsdQty = toVsdcNumber(next.rsdQty);
  }
  return next;
}

function sanitizeForEndpoint(endpoint, payload) {
  if (!payload || typeof payload !== 'object') return payload;

  const next = { ...payload };
  INTERNAL_FIELDS.forEach((field) => {
    delete next[field];
  });

  const endpointStrip = ENDPOINT_STRIP_FIELDS[endpoint];
  if (endpointStrip) {
    endpointStrip.forEach((field) => {
      delete next[field];
    });
  }

  switch (endpoint) {
    case VSDC_ENDPOINTS.SAVE_SALES:
      return sanitizeSalesPayload(next);
    case VSDC_ENDPOINTS.SAVE_PURCHASES:
      return sanitizePurchasePayload(next);
    case VSDC_ENDPOINTS.SAVE_STOCK_ITEMS:
      return sanitizeStockPayload(next);
    case VSDC_ENDPOINTS.SAVE_STOCK_MASTER:
      return sanitizeSaveStockMasterPayload(next);
    default:
      return next;
  }
}

function extractInitInfo(data) {
  if (!data || typeof data !== 'object') return {};
  if (data.info && typeof data.info === 'object') return data.info;
  return data;
}

function extractSaveSalesFiscalData(response) {
  const raw = response?.raw || response || {};
  const data = response?.data || raw.data || raw;
  const nested = data && typeof data === 'object' ? data : {};
  const receipt = nested.receipt && typeof nested.receipt === 'object' ? nested.receipt : {};

  return {
    rcptSign: nested.rcptSign || receipt.rcptSign || raw.rcptSign || null,
    intrlData: nested.intrlData || receipt.intrlData || raw.intrlData || null,
    rcptNo: nested.rcptNo ?? receipt.rcptNo ?? raw.rcptNo ?? null,
    rcptDt: nested.rcptDt || nested.vsdcRcptPbctDate || receipt.rcptPbctDt || response?.resultDt || null,
    sdcId: nested.sdcId || receipt.sdcId || raw.sdcId || null,
    mrcNo: nested.mrcNo || receipt.mrcNo || raw.mrcNo || null,
  };
}

function mapVsdcErrorCode(resultCd) {
  const code = String(resultCd || '');
  const messages = {
    881: 'Purchase confirmation is mandatory before this sale can be fiscalized. Link a valid purchase or provide prcOrdCd.',
    882: 'The purchase order code (prcOrdCd) is invalid for this transaction.',
    883: 'This purchase order code has already been used on another fiscal sale.',
    884: 'The customer TIN is invalid according to RRA.',
  };
  return messages[code] || null;
}

module.exports = {
  sanitizeForEndpoint,
  extractInitInfo,
  extractSaveSalesFiscalData,
  mapVsdcErrorCode,
  toVsdcNumber,
};
