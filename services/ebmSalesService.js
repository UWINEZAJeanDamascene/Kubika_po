const Invoice = require("../models/Invoice");
const CreditNote = require("../models/CreditNote");
const Company = require("../models/Company");
const Warehouse = require("../models/Warehouse");
const EBMCode = require("../models/EBMCode");
require("../models/Client");
require("../models/Product");
const ebmService = require("./ebmService");
const EBMQueueService = require("./ebmQueueService");
const EBMFiscalSequenceService = require("./ebmFiscalSequenceService");
const EBMTinService = require("./ebmCustomerTinService");
const { extractSaveSalesFiscalData, mapVsdcErrorCode } = require("../utils/vsdcPayloadSanitizer");
const { formatVsdcDate, formatVsdcDateTime, VSDC_ENDPOINTS } = require("./ebmService");

const SUCCESS_RESULT = "000";

function toNumber(value, fallback = 0) {
  if (value == null) return fallback;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : fallback;
  if (value && typeof value.toString === "function") {
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundRwf(value) {
  return Math.round(toNumber(value));
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]/g, " ")
    .trim();
}

function getTin(company) {
  return (
    company?.tax_identification_number ||
    company?.registration_number ||
    company?.tin
  );
}

function getInvoiceNumber(invoice) {
  return (
    invoice.ebm?.invcNo ||
    invoice.referenceNo ||
    invoice.invoiceNumber ||
    invoice.creditNoteNumber ||
    invoice._id
  );
}

function getInvoiceLines(invoice) {
  return invoice.lines && invoice.lines.length
    ? invoice.lines
    : invoice.items || [];
}

function getProduct(line) {
  return line.product && typeof line.product === "object" ? line.product : null;
}

function getProductEbm(line) {
  const product = getProduct(line);
  return product?.ebm || {};
}

function getLineName(line) {
  const product = getProduct(line);
  return line.productName || line.description || product?.name || "Item";
}

function getProductCode(line) {
  const product = getProduct(line);
  const ebm = product?.ebm || {};
  return ebm.ebmItemCode || line.productCode || line.itemCode || product?.sku;
}

function getCustomerTin(invoice) {
  return (
    invoice.customerTin ||
    invoice.client?.taxId ||
    invoice.client?.tin ||
    invoice.client?.tax_identification_number ||
    ""
  );
}

function getPurchaseOrderCode(invoice) {
  // Spec v1.0.5: prcOrdCd max 5 chars.
  return String(
    invoice.prcOrdCd ||
      invoice.purchaseOrderCode ||
      invoice.purchaseCode ||
      invoice.lpoNumber ||
      invoice.lpoNo ||
      "",
  )
    .trim()
    .slice(0, 5);
}

function parsePositiveInt(value, fallback = 1) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getReceiptNumber(invoice) {
  return parsePositiveInt(invoice.ebm?.curRcptNo, null);
}

function getReportNumber(invoice, curRcptNo) {
  return parsePositiveInt(
    invoice.ebm?.rptNo || invoice.ebm?.reportNo || curRcptNo,
    curRcptNo,
  );
}

function assertFiscalNumber(name, value) {
  const parsed = parsePositiveInt(value, null);
  if (!parsed) {
    const error = new Error(
      `Missing EBM fiscal ${name}. Allocate branch fiscal numbers before building the sales payload.`,
    );
    error.code = "EBM_FISCAL_NUMBER_MISSING";
    error.retryable = false;
    throw error;
  }
  return parsed;
}

function normalizeYesNo(value) {
  if (value === true) return "Y";
  if (value === false) return "N";
  const normalized = String(value || "").trim().toUpperCase();
  if (["Y", "YES", "TRUE", "1", "DELIVERED", "RECEIVED"].includes(normalized))
    return "Y";
  if (["N", "NO", "FALSE", "0", "NOT_DELIVERED", "PENDING"].includes(normalized))
    return "N";
  return null;
}

function getDeliveryStatus(invoice) {
  const deliveryNote =
    invoice.deliveryNote && typeof invoice.deliveryNote === "object"
      ? invoice.deliveryNote
      : null;
  return normalizeText(
    invoice.deliveryStatus ||
      invoice.delivery_state ||
      invoice.deliveryState ||
      deliveryNote?.status ||
      "",
  );
}

function getDeliveryDate(invoice) {
  const deliveryNote =
    invoice.deliveryNote && typeof invoice.deliveryNote === "object"
      ? invoice.deliveryNote
      : null;
  return (
    invoice.actualDeliveryDate ||
    invoice.deliveredAt ||
    invoice.deliveryDate ||
    deliveryNote?.actualDeliveryDate ||
    deliveryNote?.receivedDate ||
    deliveryNote?.deliveryDate ||
    invoice.confirmedDate ||
    invoice.invoiceDate ||
    invoice.createdAt ||
    new Date()
  );
}

function shouldVerifyCustomerTin(invoice) {
  const tin = String(getCustomerTin(invoice) || '').replace(/\D/g, '').slice(0, 9);
  if (!/^\d{9}$/.test(tin)) return false;
  const verification = invoice.ebmCustomerTinVerification || invoice.ebm?.customerTinVerification;
  return verification?.tin !== tin || verification?.status !== 'valid';
}
function resolvePurchaserAcceptance(invoice) {
  const explicit = normalizeYesNo(
    invoice.ebm?.prchrAcptcYn ||
      invoice.prchrAcptcYn ||
      invoice.purchaserAccepted ||
      invoice.buyerReceivedItems,
  );
  if (explicit) return explicit;

  const deliveryStatus = getDeliveryStatus(invoice);
  if (deliveryStatus) {
    return ["delivered", "received", "completed"].includes(deliveryStatus)
      ? "Y"
      : "N";
  }

  return invoice.stockDeducted === true ||
    invoice.source === "pos" ||
    invoice.invoiceDelivery === true
    ? "Y"
    : "N";
}

async function resolveRefundReasonCode(companyId, requestedCode = null) {
  if (requestedCode) return requestedCode;
  return findCode(companyId, {
    className: "refund",
    namePatterns: ["refund", "wrong", "other"],
    requiredFor: "refund reason",
  });
}

function getCustomerName(invoice) {
  return invoice.customerName || invoice.client?.name || "Walk-in Customer";
}

function buildQrString(data) {
  return [data.rcptSign, data.intrlData, data.rcptNo, data.rcptDt]
    .filter(Boolean)
    .join("|");
}

async function findCode(
  companyId,
  { className, namePatterns = [], requiredFor },
) {
  const query = {
    company: companyId,
    active: true,
    codeClassName: { $regex: className, $options: "i" },
  };
  const codes = await EBMCode.find(query)
    .sort({ sortOrder: 1, code: 1 })
    .lean();

  for (const pattern of namePatterns) {
    const regex = new RegExp(escapeRegex(pattern), "i");
    const found = codes.find(
      (code) =>
        regex.test(code.name || "") ||
        regex.test(code.description || "") ||
        regex.test(code.code || ""),
    );
    if (found) return found.code;
  }

  if (codes.length === 1) return codes[0].code;

  const error = new Error(
    `EBM code data is missing or ambiguous for ${requiredFor}. Sync RRA code data first.`,
  );
  error.code = "EBM_CODE_NOT_SYNCED";
  error.retryable = false;
  throw error;
}

async function resolveHeaderCodes(invoice, companyId) {
  const paymentCode = await resolvePaymentCode(invoice, companyId);
  const receiptCode =
    invoice.ebm?.rcptTyCd ||
    (invoice.isProforma
      ? await findCode(companyId, {
          className: "receipt",
          namePatterns: ["proforma"],
          requiredFor: "proforma receipt type",
        })
      : invoice.isCopy
        ? await findCode(companyId, {
            className: "receipt",
            namePatterns: ["copy"],
            requiredFor: "copy receipt type",
          })
        : await findCode(companyId, {
            className: "receipt",
            namePatterns: ["sale", "normal sale"],
            requiredFor: "receipt type",
          }));
  const salesCode =
    invoice.ebm?.salesTyCd ||
    (invoice.isCopy
      ? await findCode(companyId, {
          className: "transaction",
          namePatterns: ["copy"],
          requiredFor: "copy transaction type",
        })
      : invoice.isDebitNote
        ? await findCode(companyId, {
            className: "transaction",
            namePatterns: ["debit"],
            requiredFor: "debit note transaction type",
          })
        : await findCode(companyId, {
            className: "transaction",
            namePatterns: ["normal", "sale"],
            requiredFor: "sales transaction type",
          }));
  return {
    pmtTyCd: paymentCode,
    rcptTyCd: receiptCode,
    salesTyCd: salesCode,
  };
}

async function resolveRefundHeaderCodes(note, companyId) {
  const base = await resolveHeaderCodes(note, companyId);
  base.rcptTyCd = await findCode(companyId, {
    className: "receipt",
    namePatterns: ["refund"],
    requiredFor: "refund receipt type",
  });
  return base;
}

async function resolvePaymentCode(invoice, companyId, paymentMethod = null) {
  if (!paymentMethod && invoice.ebm?.pmtTyCd) return invoice.ebm.pmtTyCd;

  const payments = invoice.payments || [];
  const method = normalizeText(
    paymentMethod ||
      payments[0]?.paymentMethod ||
      (payments.length ? "cash" : "credit"),
  );
  const namePatterns = method.includes("mobile")
    ? ["mobile money", "momo"]
    : method.includes("bank")
      ? ["bank", "transfer"]
      : method.includes("card")
        ? ["card"]
        : method.includes("cheque") || method.includes("check")
          ? ["cheque", "check"]
          : method.includes("credit")
            ? ["credit"]
            : ["cash"];

  return findCode(companyId, {
    className: "payment",
    namePatterns,
    requiredFor: `payment method ${paymentMethod || method}`,
  });
}

async function resolveBranch(invoice, companyId, requestedBranchId = null) {
  if (requestedBranchId) {
    const branch = await Warehouse.findOne({
      company: companyId,
      rraBranchId: requestedBranchId,
    }).lean();
    if (branch) return branch;
  }

  const lines = getInvoiceLines(invoice);
  for (const line of lines) {
    const warehouseId = line.warehouse || getProduct(line)?.defaultWarehouse;
    if (warehouseId) {
      const branch = await Warehouse.findOne({
        _id: warehouseId,
        company: companyId,
      }).lean();
      if (branch?.rraBranchId) return branch;
    }
  }

  const branch =
    (await Warehouse.findOne({ company: companyId, isDefault: true }).lean()) ||
    (await Warehouse.findOne({ company: companyId })
      .sort({ createdAt: 1 })
      .lean());

  if (!branch?.rraBranchId) {
    const error = new Error(
      "No EBM branch ID is available for this invoice. Register a branch before submitting to RRA.",
    );
    error.code = "EBM_BRANCH_MISSING";
    error.retryable = false;
    throw error;
  }

  return branch;
}

function buildLinePayload(line, itemSeq) {
  const ebm = getProductEbm(line);
  const product = getProduct(line);
  const qty = toNumber(line.qty || line.quantity, 0);
  const unitPrice = toNumber(line.unitPrice || line.price, 0);
  const grossBeforeDiscount = qty * unitPrice;
  const discountPct = toNumber(line.discountPct, 0);
  const rawDiscount = toNumber(line.discount, 0);
  const discountAmount =
    discountPct > 0 ? grossBeforeDiscount * (discountPct / 100) : rawDiscount;
  const storedLineTotal =
    line.lineTotal != null ? line.lineTotal : line.totalWithTax;
  const lineGross = roundRwf(
    Math.max(
      0,
      storedLineTotal != null
        ? toNumber(storedLineTotal)
        : grossBeforeDiscount - discountAmount,
    ),
  );
  const taxTyCd =
    ebm.taxTyCd || ebm.taxTypeCode || line.taxCode || product?.taxCode;

  if (!taxTyCd || !["A", "B", "C", "D"].includes(taxTyCd)) {
    const error = new Error(
      `Product ${getLineName(line)} has no valid RRA tax type code.`,
    );
    error.code = "EBM_PRODUCT_TAX_CODE_MISSING";
    error.retryable = false;
    throw error;
  }

  const itemCd = getProductCode(line);
  const itemClsCd = ebm.itemClassCd || ebm.itemClassCode;
  const pkgUnitCd = ebm.pkgUnitCd || ebm.packagingUnitCode;
  const qtyUnitCd = ebm.qtyUnitCd || ebm.quantityUnitCode;

  if (!itemCd || !itemClsCd || !pkgUnitCd || !qtyUnitCd) {
    const error = new Error(
      `Product ${getLineName(line)} is missing EBM registration/classification fields.`,
    );
    error.code = "EBM_PRODUCT_CODES_MISSING";
    error.retryable = false;
    throw error;
  }

  let taxblAmt = lineGross;
  let taxAmt = 0;
  if (taxTyCd === "B") {
    taxblAmt = roundRwf(lineGross / 1.18);
    taxAmt = lineGross - taxblAmt;
  }

  return {
    itemSeq,
    itemCd,
    itemClsCd,
    itemNm: getLineName(line),
    bcd: product?.barcode || "",
    pkgUnitCd,
    pkg: 1,
    qtyUnitCd,
    qty,
    prc: roundRwf(unitPrice),
    splyAmt:
      taxTyCd === "B"
        ? roundRwf((lineGross + discountAmount) / 1.18)
        : roundRwf(grossBeforeDiscount),
    dcRt: discountPct,
    dcAmt: roundRwf(discountAmount),
    isrccCd: "",
    isrccNm: "",
    isrcRt: 0,
    isrcAmt: 0,
    taxTyCd,
    taxblAmt,
    taxAmt,
    totAmt: lineGross,
  };
}

async function buildSalesTrnPayload(invoice, company, branch) {
  if (!invoice)
    throw new Error("Invoice is required to build EBM sales payload.");
  if (!company)
    throw new Error("Company is required to build EBM sales payload.");
  if (!branch?.rraBranchId)
    throw new Error(
      "Branch with RRA branch ID is required to build EBM sales payload.",
    );

  const companyId = invoice.company || company._id;
  const tin = getTin(company);
  if (!tin) {
    const error = new Error(
      "Company TIN is required for EBM sales submission.",
    );
    error.code = "EBM_TIN_MISSING";
    error.retryable = false;
    throw error;
  }

  const headerCodes = await resolveHeaderCodes(invoice, companyId);
  const cfmDt = formatVsdcDateTime(
    invoice.confirmedDate ||
      invoice.invoiceDate ||
      invoice.createdAt ||
      new Date(),
  );
  const lines = getInvoiceLines(invoice).map((line, index) =>
    buildLinePayload(line, index + 1),
  );

  const buckets = {
    A: { taxbl: 0, tax: 0 },
    B: { taxbl: 0, tax: 0 },
    C: { taxbl: 0, tax: 0 },
    D: { taxbl: 0, tax: 0 },
  };
  lines.forEach((line) => {
    buckets[line.taxTyCd].taxbl += line.taxblAmt;
    buckets[line.taxTyCd].tax += line.taxAmt;
  });

  const totTaxblAmt = roundRwf(
    lines.reduce((sum, line) => sum + line.taxblAmt, 0),
  );
  const totTaxAmt = roundRwf(lines.reduce((sum, line) => sum + line.taxAmt, 0));
  const totAmt = roundRwf(lines.reduce((sum, line) => sum + line.totAmt, 0));
  const invcNo = assertFiscalNumber("invcNo", invoice.ebm?.invcNo);
  const curRcptNo = assertFiscalNumber("curRcptNo", getReceiptNumber(invoice));
  const totRcptNo = assertFiscalNumber(
    "totRcptNo",
    invoice.ebm?.totRcptNo || invoice.ebm?.totalRcptNo || curRcptNo,
  );
  const rcptPbctDt = formatVsdcDateTime(
    invoice.ebm?.rcptPbctDt ||
      invoice.ebm?.rcptDt ||
      invoice.confirmedDate ||
      invoice.invoiceDate ||
      invoice.createdAt ||
      new Date(),
  );
  const rptNo = getReportNumber(invoice, curRcptNo);
  const prchrAcptcYn = resolvePurchaserAcceptance(invoice);
  const stockRlsDt =
    prchrAcptcYn === "Y" ? formatVsdcDateTime(getDeliveryDate(invoice)) : null;

  return {
    companyId,
    tin,
    bhfId: branch.rraBranchId,
    invcNo,
    orgInvcNo: toNumber(invoice.originalInvoiceNo || invoice.orgInvcNo, 0),
    prcOrdCd: getPurchaseOrderCode(invoice),
    custTin: getCustomerTin(invoice),
    custNm: getCustomerName(invoice),
    rcptTyCd: headerCodes.rcptTyCd,
    pmtTyCd: headerCodes.pmtTyCd,
    salesTyCd: headerCodes.salesTyCd,
    salesSttsCd: "02", // RRA Code 4.11: '02' = Approved â€” all EBM submissions are confirmed
    cfmDt,
    salesDt: formatVsdcDate(
      invoice.invoiceDate || invoice.createdAt || new Date(),
    ),
    stockRlsDt,
    prchrAcptcYn,
    remark: (invoice.notes || "").slice(0, 400), // Spec: max 400 chars
    taxblAmtA: roundRwf(buckets.A.taxbl),
    taxblAmtB: roundRwf(buckets.B.taxbl),
    taxblAmtC: roundRwf(buckets.C.taxbl),
    taxblAmtD: roundRwf(buckets.D.taxbl),
    taxAmtA: roundRwf(buckets.A.tax),
    taxAmtB: roundRwf(buckets.B.tax),
    taxAmtC: roundRwf(buckets.C.tax),
    taxAmtD: roundRwf(buckets.D.tax),
    totItemCnt: lines.length,
    totTaxblAmt,
    totTaxAmt,
    totAmt,
    // Tax rates per type â€” B is standard 18% VAT; A/C/D are zero/exempt/non-VAT
    taxRtA: 0,
    taxRtB: 18,
    taxRtC: 0,
    taxRtD: 0,
    itemList: lines,
    receipt: {
      curRcptNo,
      totRcptNo,
      rptNo,
      trdeNm: company.name || "",
      adrs: [
        company.address?.street,
        company.address?.city,
        company.address?.country,
      ]
        .filter(Boolean)
        .join(", "),
      topMsg: "",
      btmMsg: "",
      prchrAcptcYn,
      rcptPbctDt,
      totItemCnt: lines.length,
    },
    regrId: tin || "system",
    regrNm: company.name || "System",
    modrId: tin || "system",
    modrNm: company.name || "System",
  };
}

async function buildRefundPayload(
  note,
  originalInvoice,
  company,
  branch,
  options = {},
) {
  if (
    !originalInvoice?.ebm?.rcptNo ||
    originalInvoice.ebm.ebmStatus !== "submitted"
  ) {
    const status = originalInvoice?.ebm?.ebmStatus || "not_submitted";
    const error = new Error(
      status === "pending"
        ? "Original invoice EBM submission is still pending. Wait for it to complete before submitting a refund."
        : "Original invoice has not been submitted to RRA. Submit the original invoice before processing an EBM refund.",
    );
    error.code = "EBM_ORIGINAL_INVOICE_NOT_SUBMITTED";
    error.retryable = false;
    throw error;
  }

  const payload = await buildSalesTrnPayload(note, company, branch);
  const headerCodes = await resolveRefundHeaderCodes(
    note,
    note.company || company._id,
  );
  const refundReasonCode = await resolveRefundReasonCode(
    note.company || company._id,
    options.refundRsnCd || note.ebm?.rfdRsnCd || note.ebm?.refundRsnCd,
  );
  payload.rcptTyCd = headerCodes.rcptTyCd;
  payload.pmtTyCd = headerCodes.pmtTyCd;
  payload.salesTyCd = headerCodes.salesTyCd;
  payload.orgInvcNo = toNumber(originalInvoice.ebm?.invcNo || getInvoiceNumber(originalInvoice), 0);
  payload.orgRcptNo = String(originalInvoice.ebm.rcptNo);
  payload.rfdRsnCd = refundReasonCode;
  payload.remark = note.reason || note.notes || "Refund after sale";
  return payload;
}

async function mergeInvoiceEbm(invoiceId, companyId, ebmPatch) {
  const current = await Invoice.findOne({ _id: invoiceId, company: companyId });
  if (!current) return null;
  const ebm = {
    ...(current.ebm && typeof current.ebm === 'object' ? current.ebm : {}),
    ...ebmPatch,
  };
  return Invoice.findOneAndUpdate(
    { _id: invoiceId, company: companyId },
    { $set: { ebm } },
    { new: true },
  ).populate("client lines.product createdBy");
}

async function markPending(invoiceId, companyId) {
  return mergeInvoiceEbm(invoiceId, companyId, {
    ebmStatus: "pending",
    lastError: null,
  });
}

async function applySuccess(invoiceId, companyId, response, payload) {
  const data = extractSaveSalesFiscalData(response);
  const rcptDt = data.rcptDt || formatVsdcDateTime();
  const qrCode = buildQrString({
    rcptSign: data.rcptSign,
    intrlData: data.intrlData,
    rcptNo: data.rcptNo,
    rcptDt,
  });

  return mergeInvoiceEbm(invoiceId, companyId, {
    rcptSign: data.rcptSign || null,
    intrlData: data.intrlData || null,
    rcptNo: data.rcptNo != null ? String(data.rcptNo) : null,
    rcptDt,
    qrCode,
    submittedAt: new Date(),
    ebmStatus: "submitted",
    lastError: null,
    rcptTyCd: payload.rcptTyCd,
    pmtTyCd: payload.pmtTyCd,
    salesTyCd: payload.salesTyCd,
    cfmDt: payload.cfmDt,
    prcOrdCd: payload.prcOrdCd || null,
    prchrAcptcYn: payload.prchrAcptcYn,
    invcNo: payload.invcNo,
    curRcptNo: payload.receipt?.curRcptNo || null,
    totRcptNo: payload.receipt?.totRcptNo || null,
    rptNo: payload.receipt?.rptNo || null,
    salesPayload: payload,
  });
}

function formatEbmErrorMessage(error) {
  const resultCd = error?.resultCd || error?.response?.resultCd;
  const mapped = mapVsdcErrorCode(resultCd);
  if (mapped) return mapped;
  return error?.message || "EBM sales submission failed";
}

async function applyFailure(invoiceId, companyId, error, payload = null) {
  const status = error?.retryable === false ? "failed" : "pending";
  const current = await Invoice.findOne({ _id: invoiceId, company: companyId });
  if (!current) return null;
  const prev = current.ebm && typeof current.ebm === 'object' ? current.ebm : {};
  const ebm = {
    ...prev,
    ebmStatus: status,
    lastError: formatEbmErrorMessage(error),
    lastErrorCode: error?.resultCd || error?.code || null,
    retryCount: (Number(prev.retryCount) || 0) + 1,
    ...(payload
      ? {
          rcptTyCd: payload.rcptTyCd,
          pmtTyCd: payload.pmtTyCd,
          salesTyCd: payload.salesTyCd,
          cfmDt: payload.cfmDt,
          prcOrdCd: payload.prcOrdCd || null,
          prchrAcptcYn: payload.prchrAcptcYn,
          invcNo: payload.invcNo,
          curRcptNo: payload.receipt?.curRcptNo || null,
          totRcptNo: payload.receipt?.totRcptNo || null,
          rptNo: payload.receipt?.rptNo || null,
          salesPayload: payload,
        }
      : {}),
  };
  return Invoice.findOneAndUpdate(
    { _id: invoiceId, company: companyId },
    { $set: { ebm } },
    { new: true },
  ).populate("client lines.product createdBy");
}

async function markCreditNotePending(noteId, companyId, extra = {}) {
  return CreditNote.findOneAndUpdate(
    {
      _id: noteId,
      company: companyId,
      "ebm.ebmStatus": { $ne: "submitted" },
    },
    {
      $set: {
        "ebm.ebmStatus": "pending",
        "ebm.lastError": null,
        ...extra,
      },
    },
    { new: true },
  ).populate("invoice client lines.product items.product createdBy");
}

async function applyCreditNoteSuccess(noteId, companyId, response, payload) {
  const data = extractSaveSalesFiscalData(response);
  const rcptDt = data.rcptDt || formatVsdcDateTime();
  const qrCode = buildQrString({
    rcptSign: data.rcptSign,
    intrlData: data.intrlData,
    rcptNo: data.rcptNo,
    rcptDt,
  });

  return CreditNote.findOneAndUpdate(
    { _id: noteId, company: companyId, "ebm.ebmStatus": { $ne: "submitted" } },
    {
      $set: {
        "ebm.rcptSign": data.rcptSign || null,
        "ebm.intrlData": data.intrlData || null,
        "ebm.rcptNo": data.rcptNo != null ? String(data.rcptNo) : null,
        "ebm.rcptDt": rcptDt,
        "ebm.qrCode": qrCode,
        "ebm.submittedAt": new Date(),
        "ebm.ebmStatus": "submitted",
        "ebm.lastError": null,
        "ebm.rcptTyCd": payload.rcptTyCd,
        "ebm.pmtTyCd": payload.pmtTyCd,
        "ebm.salesTyCd": payload.salesTyCd,
        "ebm.cfmDt": payload.cfmDt,
        "ebm.prchrAcptcYn": payload.prchrAcptcYn,
        "ebm.invcNo": payload.invcNo,
        "ebm.curRcptNo": payload.receipt?.curRcptNo || null,
        "ebm.totRcptNo": payload.receipt?.totRcptNo || null,
        "ebm.rptNo": payload.receipt?.rptNo || null,
        "ebm.orgRcptNo": payload.orgRcptNo,
        "ebm.rfdRsnCd": payload.rfdRsnCd,
        "ebm.salesPayload": payload,
      },
    },
    { new: true },
  ).populate("invoice client lines.product items.product createdBy");
}

async function applyCreditNoteFailure(
  noteId,
  companyId,
  error,
  payload = null,
) {
  const status = error?.retryable === false ? "failed" : "pending";
  return CreditNote.findOneAndUpdate(
    { _id: noteId, company: companyId, "ebm.ebmStatus": { $ne: "submitted" } },
    {
      $set: {
        "ebm.ebmStatus": status,
        "ebm.lastError": formatEbmErrorMessage(error),
        "ebm.lastErrorCode": error?.resultCd || error?.code || null,
        ...(payload
          ? {
              "ebm.rcptTyCd": payload.rcptTyCd,
              "ebm.pmtTyCd": payload.pmtTyCd,
              "ebm.salesTyCd": payload.salesTyCd,
              "ebm.cfmDt": payload.cfmDt,
              "ebm.prchrAcptcYn": payload.prchrAcptcYn,
              "ebm.invcNo": payload.invcNo,
              "ebm.curRcptNo": payload.receipt?.curRcptNo || null,
              "ebm.totRcptNo": payload.receipt?.totRcptNo || null,
              "ebm.rptNo": payload.receipt?.rptNo || null,
              "ebm.orgRcptNo": payload.orgRcptNo,
              "ebm.rfdRsnCd": payload.rfdRsnCd,
              "ebm.salesPayload": payload,
            }
          : {}),
      },
      $inc: { "ebm.retryCount": 1 },
    },
    { new: true },
  ).populate("invoice client lines.product items.product createdBy");
}

async function submitInvoiceVariant(invoiceId, companyId, variant = {}) {
  const invoice = await Invoice.findOne({ _id: invoiceId, company: companyId });
  if (!invoice) {
    const error = new Error("Invoice not found for EBM submission.");
    error.code = "EBM_INVOICE_NOT_FOUND";
    error.retryable = false;
    throw error;
  }
  if (variant.isProforma) {
    invoice.isProforma = true;
    invoice.isCopy = false;
  } else if (variant.isCopy) {
    invoice.isCopy = true;
    invoice.isProforma = false;
  } else {
    invoice.isProforma = false;
    invoice.isCopy = false;
  }
  await invoice.save();
  return submitInvoice(invoiceId, { companyId, branchId: variant.branchId || null });
}

async function submitCreditNote(
  noteId,
  { companyId, branchId = null, refundRsnCd = null } = {},
) {
  const note = await CreditNote.findOne({ _id: noteId, company: companyId })
    .populate("invoice")
    .populate("client")
    .populate("lines.product")
    .populate("items.product")
    .populate("createdBy");
  if (!note) {
    const error = new Error("Credit note not found for EBM refund submission.");
    error.code = "EBM_CREDIT_NOTE_NOT_FOUND";
    error.retryable = false;
    throw error;
  }
  if (note.ebm?.ebmStatus === "submitted") return note;

  const originalInvoice = await Invoice.findOne({
    _id: note.invoice?._id || note.invoice,
    company: companyId,
  })
    .populate("lines.product")
    .lean();
  const orgRcptNo = originalInvoice?.ebm?.rcptNo || null;
  await markCreditNotePending(note._id, companyId, {
    "ebm.orgRcptNo": orgRcptNo,
    ...(refundRsnCd ? { "ebm.rfdRsnCd": refundRsnCd } : {}),
  });

  const company = await Company.findById(companyId).lean();
  const branch = await resolveBranch(note, companyId, branchId);
  await EBMFiscalSequenceService.ensureSalesNumbers(
    note,
    companyId,
    branch.rraBranchId,
    (updates) => CreditNote.updateOne(
      { _id: note._id, company: companyId, "ebm.ebmStatus": { $ne: "submitted" } },
      { $set: updates },
    ),
  );
  let payload = null;

  try {
    payload = await buildRefundPayload(note, originalInvoice, company, branch, {
      refundRsnCd,
    });
    const response = await ebmService.saveSales(payload);
    if (response.resultCd !== SUCCESS_RESULT) {
      const error = new Error(
        response.resultMsg || "RRA rejected refund submission.",
      );
      error.response = response;
      throw error;
    }
    const submitted = await applyCreditNoteSuccess(
      note._id,
      companyId,
      response,
      payload,
    );
    await EBMQueueService.markSubmitted({
      companyId,
      documentType: "creditNote",
      documentId: note._id,
      endpoint: VSDC_ENDPOINTS.SAVE_SALES,
    }).catch(() => {});
    require("./ebmStockService")
      .submitStockForCreditNote(note._id, { companyId, branchId })
      .catch((stockError) =>
        console.error(
          "[EBMSales] Credit note stock reporting failed:",
          stockError.message,
        ),
      );
    return submitted;
  } catch (error) {
    const failedNote = await applyCreditNoteFailure(
      note._id,
      companyId,
      error,
      payload,
    );
    if (payload && error?.retryable !== false) {
      await EBMQueueService.upsertFailure({
        companyId,
        documentType: "creditNote",
        documentId: note._id,
        endpoint: VSDC_ENDPOINTS.SAVE_SALES,
        payload,
        error,
      }).catch(() => {});
    }
    error.creditNote = failedNote;
    throw error;
  }
}

async function submitInvoice(invoiceId, { companyId, branchId = null } = {}) {
  const invoice = await Invoice.findOne({ _id: invoiceId, company: companyId })
    .populate("client")
    .populate("deliveryNote")
    .populate("lines.product")
    .populate("createdBy");
  if (!invoice) {
    const error = new Error("Invoice not found for EBM sales submission.");
    error.code = "EBM_INVOICE_NOT_FOUND";
    error.retryable = false;
    throw error;
  }

  if (invoice.ebm?.ebmStatus === "submitted") return invoice;

  const company = await Company.findById(companyId).lean();
  const branch = await resolveBranch(invoice, companyId, branchId);
  if (shouldVerifyCustomerTin(invoice)) {
    await EBMTinService.verifyInvoiceCustomerTin(companyId, invoice._id, { branchId: branch.rraBranchId });
    const verified = await Invoice.findOne({ _id: invoice._id, company: companyId })
      .populate("client")
      .populate("deliveryNote")
      .populate("lines.product")
      .populate("createdBy");
    if (verified) {
      invoice.ebmCustomerTinVerification = verified.ebmCustomerTinVerification;
      invoice.ebm = verified.ebm;
    }
  }
  await EBMFiscalSequenceService.ensureSalesNumbers(
    invoice,
    companyId,
    branch.rraBranchId,
    async (updates) => {
      const patch = {};
      for (const [key, value] of Object.entries(updates || {})) {
        patch[key.startsWith('ebm.') ? key.slice(4) : key] = value;
      }
      return mergeInvoiceEbm(invoice._id, companyId, patch);
    },
  );
  await markPending(invoice._id, companyId);
  let payload = null;

  try {
    payload = await buildSalesTrnPayload(invoice, company, branch);
    const response = await ebmService.saveSales(payload);
    if (response.resultCd !== SUCCESS_RESULT) {
      const error = new Error(
        response.resultMsg || "RRA rejected sales submission.",
      );
      error.response = response;
      throw error;
    }
    const submitted = await applySuccess(
      invoice._id,
      companyId,
      response,
      payload,
    );
    await EBMQueueService.markSubmitted({
      companyId,
      documentType: invoice.source === "pos" ? "pos" : "invoice",
      documentId: invoice._id,
      endpoint: VSDC_ENDPOINTS.SAVE_SALES,
    }).catch(() => {});
    require("./ebmStockService")
      .submitStockForInvoice(invoice._id, { companyId, branchId })
      .catch((stockError) =>
        console.error(
          "[EBMSales] Invoice stock reporting failed:",
          stockError.message,
        ),
      );
    return submitted;
  } catch (error) {
    const failedInvoice = await applyFailure(
      invoice._id,
      companyId,
      error,
      payload,
    );
    if (payload && error?.retryable !== false) {
      await EBMQueueService.upsertFailure({
        companyId,
        documentType: invoice.source === "pos" ? "pos" : "invoice",
        documentId: invoice._id,
        endpoint: VSDC_ENDPOINTS.SAVE_SALES,
        payload,
        error,
      }).catch(() => {});
    }
    error.invoice = failedInvoice;
    throw error;
  }
}

function submitInvoiceAsync(invoiceId, options = {}) {
  setImmediate(() => {
    submitInvoice(invoiceId, options).catch((error) => {
      console.error("[EBMSales] Async sales submission failed:", error.message);
    });
  });
}

module.exports = {
  buildSalesTrnPayload,
  buildRefundPayload,
  markPending,
  markCreditNotePending,
  submitInvoice,
  submitInvoiceVariant,
  submitInvoiceAsync,
  submitCreditNote,
  resolveBranch,
  formatEbmErrorMessage,
};
