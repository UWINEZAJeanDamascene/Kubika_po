const Company = require("../models/Company");
const Warehouse = require("../models/Warehouse");
const Product = require("../models/Product");
const Supplier = require("../models/Supplier");
const Client = require("../models/Client");
const Invoice = require("../models/Invoice");
const CreditNote = require("../models/CreditNote");
const GoodsReceivedNote = require("../models/GoodsReceivedNote");
const Purchase = require("../models/Purchase");
const StockMovement = require("../models/StockMovement");
const StockTransfer = require("../models/StockTransfer");
const EBMCode = require("../models/EBMCode");
const ebmService = require("./ebmService");
const EBMQueueService = require("./ebmQueueService");
const { formatVsdcDate, VSDC_ENDPOINTS } = require("./ebmService");
const {
  EBM_STOCK_TYPE_CODES,
  getAdjustmentCode,
} = require("../constants/ebmStockTypeCodes");

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

function getTin(company) {
  return (
    company?.tax_identification_number ||
    company?.registration_number ||
    company?.tin
  );
}

async function resolveBranchByWarehouse(
  companyId,
  warehouseId,
  branchId = null,
) {
  if (branchId) {
    const branch = await Warehouse.findOne({
      company: companyId,
      rraBranchId: branchId,
    }).lean();
    if (branch) return branch;
  }
  if (warehouseId) {
    const branch = await Warehouse.findOne({
      company: companyId,
      _id: warehouseId,
    }).lean();
    if (branch?.rraBranchId) return branch;
  }
  const fallback =
    (await Warehouse.findOne({ company: companyId, isDefault: true }).lean()) ||
    (await Warehouse.findOne({ company: companyId })
      .sort({ createdAt: 1 })
      .lean());
  if (!fallback?.rraBranchId) {
    const error = new Error(
      "No RRA branch ID is available for EBM stock reporting.",
    );
    error.code = "EBM_BRANCH_MISSING";
    error.retryable = false;
    throw error;
  }
  return fallback;
}

async function resolveRegistrationTypeCode(companyId) {
  const code = await EBMCode.findOne({
    company: companyId,
    active: true,
    codeClassName: { $regex: "Registration Type", $options: "i" },
    $or: [{ name: { $regex: "Manual", $options: "i" } }, { code: "M" }],
  }).lean();
  return code?.code || "M";
}

function getProductEbm(product) {
  return product?.ebm || {};
}

function getItemCode(product) {
  const ebm = getProductEbm(product);
  return ebm.ebmItemCode || product?.sku || product?.code;
}

function calculateLineAmounts({ product, qty, unitPrice, totalAmount = null }) {
  const ebm = getProductEbm(product);
  const taxTyCd = ebm.taxTyCd || product?.taxCode || "D";
  const gross = roundRwf(
    totalAmount != null ? totalAmount : toNumber(qty) * toNumber(unitPrice),
  );
  let taxblAmt = gross;
  let taxAmt = 0;
  if (taxTyCd === "B") {
    taxblAmt = roundRwf(gross / 1.18);
    taxAmt = gross - taxblAmt;
  }
  return { taxTyCd, taxblAmt, taxAmt, totAmt: gross, splyAmt: taxblAmt };
}

function formatOptionalVsdcDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return formatVsdcDate(date);
}

function formatOptionalBarcode(value) {
  return value ? String(value).slice(0, 20) : "";
}

function buildItemPayload(product, values, itemSeq) {
  const ebm = getProductEbm(product);
  const qty = toNumber(values.qty);
  const unitPrice = roundRwf(values.unitPrice);
  const discountAmount = roundRwf(
    values.discountAmount ?? values.discount ?? values.totalDiscount ?? 0,
  );
  const amounts = calculateLineAmounts({
    product,
    qty,
    unitPrice,
    totalAmount: values.totalAmount,
  });

  if (
    !getItemCode(product) ||
    !ebm.itemClassCd ||
    !ebm.pkgUnitCd ||
    !ebm.qtyUnitCd
  ) {
    const error = new Error(
      `Product ${product?.name || product?._id} is missing EBM item fields for stock reporting.`,
    );
    error.code = "EBM_PRODUCT_CODES_MISSING";
    error.retryable = false;
    throw error;
  }

  return {
    itemSeq,
    itemCd: getItemCode(product),
    itemClsCd: ebm.itemClassCd,
    itemNm: product.name,
    bcd: formatOptionalBarcode(product?.barcode),
    pkgUnitCd: ebm.pkgUnitCd,
    pkg: 1,
    qtyUnitCd: ebm.qtyUnitCd,
    qty: Math.abs(qty),
    itemExprDt: formatOptionalVsdcDate(values.expiryDate),
    bhfTinTyCd: values.bhfTinTyCd || "",
    prc: unitPrice,
    splyAmt: amounts.splyAmt,
    totDcAmt: discountAmount,
    taxblAmt: amounts.taxblAmt,
    taxTyCd: amounts.taxTyCd,
    taxAmt: amounts.taxAmt,
    totAmt: amounts.totAmt,
  };
}

function buildMasterPayload(itemData, company, branch) {
  const product = itemData.product;
  const tin = getTin(company);
  // Spec 3.3.8.3 StockMstSaveReq — only these fields are required
  return {
    companyId: company._id || company.id,
    tin,
    bhfId: branch.rraBranchId,
    itemCd: getItemCode(product),
    rsdQty: toNumber(
      itemData.currentQty != null ? itemData.currentQty : product.currentStock,
    ),
    regrId: tin || "system",
    regrNm: company.name || "System",
    modrId: tin || "system",
    modrNm: company.name || "System",
  };
}

async function buildMovementPayload(movementData, company, branch) {
  const itemList = movementData.items.map((item, index) =>
    buildItemPayload(item.product, item, index + 1),
  );
  return {
    companyId: company._id || company.id,
    tin: getTin(company),
    bhfId: branch.rraBranchId,
    sarNo: (() => {
      // Spec: sarNo is NUMBER type. Extract digits from ref or fall back to timestamp.
      const raw =
        movementData.referenceNo || movementData.documentId || Date.now();
      const digits = String(raw).replace(/\D/g, "");
      return digits
        ? parseInt(digits.slice(-15), 10) || Date.now()
        : Date.now();
    })(),
    orgSarNo: movementData.orgSarNo || 0,
    regTyCd: await resolveRegistrationTypeCode(company._id || company.id),
    custTin: movementData.custTin || "",
    custNm: movementData.custNm || "",
    custBhfId: movementData.custBhfId || "",
    sarTyCd: movementData.sarTyCd,
    ocrnDt: formatVsdcDate(movementData.occurrenceDate || new Date()),
    totItemCnt: itemList.length,
    totTaxblAmt: roundRwf(
      itemList.reduce((sum, item) => sum + item.taxblAmt, 0),
    ),
    totTaxAmt: roundRwf(itemList.reduce((sum, item) => sum + item.taxAmt, 0)),
    totAmt: roundRwf(itemList.reduce((sum, item) => sum + item.totAmt, 0)),
    remark: movementData.remark || "",
    itemList,
  };
}

async function updateDocumentStockStatus(
  Model,
  documentId,
  companyId,
  status,
  error = null,
) {
  const usesPrimaryEbmStatus = [
    "GoodsReceivedNote",
    "Purchase",
    "StockMovement",
    "StockTransfer",
  ].includes(Model.modelName);
  const update = {
    "ebm.stockStatus": status,
    "ebm.stockLastError": error
      ? error.message || "EBM stock submission failed"
      : null,
    ...(status === "submitted" ? { "ebm.stockSubmittedAt": new Date() } : {}),
    ...(usesPrimaryEbmStatus
      ? {
          "ebm.ebmStatus": status,
          "ebm.lastError": error
            ? error.message || "EBM stock submission failed"
            : null,
          ...(status === "submitted" ? { "ebm.submittedAt": new Date() } : {}),
        }
      : {}),
  };
  const inc =
    status === "pending" || status === "failed"
      ? { "ebm.stockRetryCount": 1 }
      : {};
  return Model.findOneAndUpdate(
    {
      _id: documentId,
      $or: [{ company: companyId }, { company_id: companyId }],
    },
    { $set: update, ...(Object.keys(inc).length ? { $inc: inc } : {}) },
    { new: true },
  );
}

async function queueFailure({
  companyId,
  documentType,
  documentId,
  endpoint,
  operationKey,
  payload,
  error,
}) {
  if (error?.retryable === false) return null;
  return EBMQueueService.upsertFailure({
    companyId,
    documentType,
    documentId,
    endpoint,
    operationKey,
    payload,
    error,
    isRetryable: true,
  });
}

async function callStockMovement(payload, context) {
  try {
    const response = await ebmService.saveStockItems(payload);
    if (response.resultCd !== SUCCESS_RESULT)
      throw new Error(response.resultMsg || "RRA rejected stock movement.");
    await EBMQueueService.markSubmitted({
      ...context,
      endpoint: VSDC_ENDPOINTS.SAVE_STOCK_ITEMS,
    });
    return response;
  } catch (error) {
    await queueFailure({
      ...context,
      endpoint: VSDC_ENDPOINTS.SAVE_STOCK_ITEMS,
      payload,
      error,
    });
    throw error;
  }
}

async function callStockMaster(payload, context) {
  try {
    const response = await ebmService.saveStockMaster(payload);
    if (response.resultCd !== SUCCESS_RESULT)
      throw new Error(response.resultMsg || "RRA rejected stock master.");
    await EBMQueueService.markSubmitted({
      ...context,
      endpoint: VSDC_ENDPOINTS.SAVE_STOCK_MASTER,
    });
    return response;
  } catch (error) {
    await queueFailure({
      ...context,
      endpoint: VSDC_ENDPOINTS.SAVE_STOCK_MASTER,
      payload,
      error,
    });
    throw error;
  }
}

async function submitStockEvent({
  companyId,
  documentType,
  documentId,
  sourceModel,
  branch,
  movementData,
  masterItems,
}) {
  const company = await Company.findById(companyId).lean();
  if (!company) throw new Error("Company not found for EBM stock reporting.");
  const movementPayload = await buildMovementPayload(
    movementData,
    company,
    branch,
  );
  const queueDocumentType = ["GoodsReceivedNote", "Purchase"].includes(
    sourceModel.modelName,
  )
    ? sourceModel.modelName
    : documentType;
  const context = { companyId, documentType: queueDocumentType, documentId };

  try {
    await updateDocumentStockStatus(
      sourceModel,
      documentId,
      companyId,
      "pending",
    );
    await callStockMovement(movementPayload, {
      ...context,
      operationKey: movementPayload.sarNo,
    });
    for (const item of masterItems) {
      const masterPayload = buildMasterPayload(item, company, branch);
      await callStockMaster(masterPayload, {
        ...context,
        operationKey: `${movementPayload.sarNo}:${masterPayload.itemCd}`,
      });
    }
    await updateDocumentStockStatus(
      sourceModel,
      documentId,
      companyId,
      "submitted",
    );
    return { submitted: true };
  } catch (error) {
    await updateDocumentStockStatus(
      sourceModel,
      documentId,
      companyId,
      error?.retryable === false ? "failed" : "pending",
      error,
    );
    console.error("[EBMStock] Stock submission failed:", error.message);
    return { submitted: false, error };
  }
}

async function submitStockForGRN(grnId, { companyId, branchId = null } = {}) {
  const grn = await GoodsReceivedNote.findOne({
    _id: grnId,
    company: companyId,
  })
    .populate("lines.product")
    .populate("supplier")
    .lean();
  if (!grn || grn.ebm?.stockStatus === "submitted") return grn;
  const branch = await resolveBranchByWarehouse(
    companyId,
    grn.warehouse,
    branchId,
  );
  const items = grn.lines.map((line) => ({
    product: line.product,
    qty: line.qtyReceived,
    unitPrice: line.unitCost,
    totalAmount: toNumber(line.qtyReceived) * toNumber(line.unitCost),
    currentQty: line.product?.currentStock,
    expiryDate: line.expiryDate,
  }));
  return submitStockEvent({
    companyId,
    documentType: "stockMovement",
    documentId: grn._id,
    sourceModel: GoodsReceivedNote,
    branch,
    movementData: {
      documentId: grn._id,
      referenceNo: grn.referenceNo,
      sarTyCd: grn.ebmImportReference
        ? EBM_STOCK_TYPE_CODES.IMPORT_CONFIRMED_STOCK_IN
        : EBM_STOCK_TYPE_CODES.GRN_PURCHASE_RECEIPT,
      occurrenceDate: grn.confirmedAt || grn.receivedDate,
      custTin: grn.supplier?.taxId || grn.supplier?.tin || "",
      custNm: grn.supplier?.name || "",
      remark: `GRN ${grn.referenceNo}`,
      items,
    },
    masterItems: items,
  });
}

async function submitStockForDirectPurchase(
  purchaseId,
  { companyId, branchId = null } = {},
) {
  const purchase = await Purchase.findOne({
    _id: purchaseId,
    company: companyId,
  })
    .populate("items.product")
    .populate("supplier")
    .lean();
  if (!purchase || purchase.ebm?.stockStatus === "submitted") return purchase;
  const branch = await resolveBranchByWarehouse(
    companyId,
    purchase.warehouse || purchase.items?.[0]?.warehouse,
    branchId,
  );
  const items = (purchase.items || []).map((line) => ({
    product: line.product,
    qty: line.quantity,
    unitPrice: line.unitCost,
    totalAmount: line.totalWithTax || line.subtotal,
    discount: line.discount,
    currentQty: line.product?.currentStock,
    expiryDate: line.expiryDate,
  }));
  return submitStockEvent({
    companyId,
    documentType: "stockMovement",
    documentId: purchase._id,
    sourceModel: Purchase,
    branch,
    movementData: {
      documentId: purchase._id,
      referenceNo: purchase.purchaseNumber,
      sarTyCd: EBM_STOCK_TYPE_CODES.GRN_PURCHASE_RECEIPT,
      occurrenceDate:
        purchase.receivedDate || purchase.purchaseDate || purchase.updatedAt,
      custTin:
        purchase.supplierTin ||
        purchase.supplier?.taxId ||
        purchase.supplier?.tin ||
        "",
      custNm: purchase.supplierName || purchase.supplier?.name || "",
      remark: `Direct purchase ${purchase.purchaseNumber}`,
      items,
    },
    masterItems: items,
  });
}

async function submitStockForInvoice(
  invoiceId,
  { companyId, branchId = null } = {},
) {
  const invoice = await Invoice.findOne({ _id: invoiceId, company: companyId })
    .populate("lines.product")
    .populate("client")
    .lean();
  if (!invoice || invoice.ebm?.stockStatus === "submitted") return invoice;
  if (invoice.ebm?.ebmStatus !== "submitted") return invoice;
  const firstWarehouse = invoice.lines.find(
    (line) => line.warehouse,
  )?.warehouse;
  const branch = await resolveBranchByWarehouse(
    companyId,
    firstWarehouse,
    branchId,
  );
  const items = invoice.lines.map((line) => ({
    product: line.product,
    qty: line.qty || line.quantity,
    unitPrice: line.unitPrice,
    totalAmount: line.lineTotal,
    discount: line.discount || line.discountAmount,
    currentQty: line.product?.currentStock,
  }));
  return submitStockEvent({
    companyId,
    documentType: invoice.source === "pos" ? "pos" : "invoice",
    documentId: invoice._id,
    sourceModel: Invoice,
    branch,
    movementData: {
      documentId: invoice._id,
      referenceNo: invoice.referenceNo,
      sarTyCd: EBM_STOCK_TYPE_CODES.SALE_OUT,
      occurrenceDate:
        invoice.confirmedDate || invoice.invoiceDate || invoice.createdAt,
      custTin:
        invoice.customerTin ||
        invoice.client?.taxId ||
        invoice.client?.tin ||
        "",
      custNm: invoice.customerName || invoice.client?.name || "",
      remark: `Sale ${invoice.referenceNo} / RRA receipt ${invoice.ebm.rcptNo}`,
      items,
    },
    masterItems: items,
  });
}

async function submitStockForCreditNote(
  noteId,
  { companyId, branchId = null } = {},
) {
  const note = await CreditNote.findOne({ _id: noteId, company: companyId })
    .populate("lines.product")
    .populate("items.product")
    .populate("client")
    .lean();
  if (!note || note.ebm?.stockStatus === "submitted") return note;
  if (note.ebm?.ebmStatus !== "submitted") return note;
  const lines = note.lines?.length ? note.lines : note.items || [];
  const branch = await resolveBranchByWarehouse(
    companyId,
    lines.find((line) => line.warehouse)?.warehouse,
    branchId,
  );
  const items = lines.map((line) => ({
    product: line.product,
    qty: line.qty || line.quantity || line.qtyReturned,
    unitPrice: line.unitPrice || line.price,
    totalAmount: line.lineTotal || line.totalWithTax,
    discount: line.discount || line.discountAmount,
    currentQty: line.product?.currentStock,
  }));
  return submitStockEvent({
    companyId,
    documentType: "creditNote",
    documentId: note._id,
    sourceModel: CreditNote,
    branch,
    movementData: {
      documentId: note._id,
      referenceNo: note.creditNoteNumber || note.referenceNo || note._id,
      sarTyCd: EBM_STOCK_TYPE_CODES.CUSTOMER_RETURN_IN,
      occurrenceDate: note.approvedAt || note.createdAt,
      custTin: note.client?.taxId || note.client?.tin || "",
      custNm: note.client?.name || "",
      remark: `Sales return ${note.creditNoteNumber || note.referenceNo} / RRA receipt ${note.ebm.rcptNo}`,
      items,
    },
    masterItems: items,
  });
}

async function submitStockAdjustment(
  movementId,
  { companyId, branchId = null } = {},
) {
  const movement = await StockMovement.findOne({
    _id: movementId,
    company: companyId,
  })
    .populate("product")
    .lean();
  if (!movement || movement.ebm?.stockStatus === "submitted") return movement;
  const branch = await resolveBranchByWarehouse(
    companyId,
    movement.warehouse,
    branchId,
  );
  const direction =
    movement.type === "in" ||
    toNumber(movement.newStock) > toNumber(movement.previousStock)
      ? "in"
      : "out";
  const item = {
    product: movement.product,
    qty: movement.quantity,
    unitPrice: movement.unitCost,
    totalAmount: movement.totalCost,
    discount: 0,
    currentQty: movement.newStock,
    expiryDate: movement.expiryDate,
  };
  return submitStockEvent({
    companyId,
    documentType: "stockAdjustment",
    documentId: movement._id,
    sourceModel: StockMovement,
    branch,
    movementData: {
      documentId: movement._id,
      referenceNo: movement.referenceNumber || movement._id,
      sarTyCd:
        movement.reason === "initial_stock"
          ? EBM_STOCK_TYPE_CODES.OPENING_STOCK
          : getAdjustmentCode(direction),
      occurrenceDate: movement.movementDate,
      remark: movement.notes || `Stock adjustment ${movement.reason}`,
      items: [item],
    },
    masterItems: [item],
  });
}

async function submitBranchTransfer(transferId, { companyId } = {}) {
  const transfer = await StockTransfer.findOne({
    _id: transferId,
    company: companyId,
  })
    .populate({ path: "items", populate: { path: "product" } })
    .lean();
  if (!transfer || transfer.ebm?.stockStatus === "submitted") return transfer;
  const [sourceBranch, destBranch] = await Promise.all([
    resolveBranchByWarehouse(companyId, transfer.fromWarehouse),
    resolveBranchByWarehouse(companyId, transfer.toWarehouse),
  ]);
  const company = await Company.findById(companyId).lean();
  const items = transfer.items.map((line) => {
    const qty = toNumber(line.qty || line.quantity);
    const unitPrice = toNumber(line.unitCost || line.product?.averageCost || 0);
    return {
      product: line.product,
      qty,
      unitPrice,
      totalAmount: qty * unitPrice,
      discount: 0,
      currentQty: line.product?.currentStock,
    };
  });

  const outPayload = await buildMovementPayload(
    {
      documentId: transfer._id,
      referenceNo: `${transfer.transferNumber}-OUT`,
      sarTyCd: EBM_STOCK_TYPE_CODES.BRANCH_TRANSFER_OUT,
      occurrenceDate: transfer.confirmedAt || transfer.transferDate,
      custTin: getTin(company),
      custNm: company.name,
      custBhfId: destBranch.rraBranchId,
      remark: `Branch transfer out ${transfer.transferNumber}`,
      items,
    },
    company,
    sourceBranch,
  );
  const inPayload = await buildMovementPayload(
    {
      documentId: transfer._id,
      referenceNo: `${transfer.transferNumber}-IN`,
      sarTyCd: EBM_STOCK_TYPE_CODES.BRANCH_TRANSFER_IN,
      occurrenceDate:
        transfer.receivedDate ||
        transfer.completedDate ||
        transfer.confirmedAt ||
        transfer.transferDate,
      custTin: getTin(company),
      custNm: company.name,
      custBhfId: sourceBranch.rraBranchId,
      remark: `Branch transfer in ${transfer.transferNumber}`,
      items,
    },
    company,
    destBranch,
  );

  try {
    await updateDocumentStockStatus(
      StockTransfer,
      transfer._id,
      companyId,
      "pending",
    );
    await callStockMovement(outPayload, {
      companyId,
      documentType: "branchTransfer",
      documentId: transfer._id,
      operationKey: outPayload.sarNo,
    });
    for (const item of items) {
      const masterPayload = buildMasterPayload(item, company, sourceBranch);
      await callStockMaster(masterPayload, {
        companyId,
        documentType: "branchTransfer",
        documentId: transfer._id,
        operationKey: `${outPayload.sarNo}:${masterPayload.itemCd}`,
      });
    }
    await callStockMovement(inPayload, {
      companyId,
      documentType: "branchTransfer",
      documentId: transfer._id,
      operationKey: inPayload.sarNo,
    });
    for (const item of items) {
      const masterPayload = buildMasterPayload(item, company, destBranch);
      await callStockMaster(masterPayload, {
        companyId,
        documentType: "branchTransfer",
        documentId: transfer._id,
        operationKey: `${inPayload.sarNo}:${masterPayload.itemCd}`,
      });
    }
    await updateDocumentStockStatus(
      StockTransfer,
      transfer._id,
      companyId,
      "submitted",
    );
  } catch (error) {
    await updateDocumentStockStatus(
      StockTransfer,
      transfer._id,
      companyId,
      error?.retryable === false ? "failed" : "pending",
      error,
    );
  }
  return StockTransfer.findOne({ _id: transferId, company: companyId });
}

module.exports = {
  saveStockMovement: callStockMovement,
  saveStockMaster: callStockMaster,
  submitStockEvent,
  submitStockForGRN,
  submitStockForDirectPurchase,
  submitStockForInvoice,
  submitStockForCreditNote,
  submitStockAdjustment,
  submitBranchTransfer,
  __test__: {
    buildItemPayload,
  },
};
