/**
 * Phase 5 (Sales/AR) + Phase 6 (Purchases/AP) mappers.
 */

const { generateObjectId, toIdString } = require('./objectId');
const { decimalToNumber, decimalToString, mapTimestamps } = require('./decimalHelpers');
const { tenantCreateBase } = require('./inventoryJournalMappers');
const { mergeUpdatePayload } = require('./masterDataMappers');
const { withReferenceNo } = require('./referenceNumbers');

const moneyStr = (v) => decimalToString(v, 2);
const qtyNum = (v) => decimalToNumber(v, 0);

function mapLines(row, mapper, key = 'lines') {
  return (row[key] || []).sort((a, b) => (a.lineOrder ?? 0) - (b.lineOrder ?? 0)).map(mapper);
}

function lineBase(row, extra = {}) {
  return {
    _id: row.id,
    lineId: row.lineId || row.id,
    product: row.productId,
    ...extra,
  };
}

/** Included Prisma relation rows carry `id`; legacy consumers expect `_id`. */
function relationRef(row, id) {
  if (!row || typeof row !== 'object') return id ?? null;
  const { id: rowId, ...rest } = row;
  return { _id: rowId, ...rest };
}

// ── Quotation ────────────────────────────────────────────────────────────────

function quotationLineToApi(row) {
  if (!row) return null;
  return {
    ...lineBase(row, {
      productName: row.productName ?? null,
      productSku: row.productSku ?? null,
      productUnit: row.productUnit ?? null,
      description: row.description ?? null,
      qty: qtyNum(row.qty),
      unit: row.unit ?? null,
      unitPrice: qtyNum(row.unitPrice),
      discountPct: qtyNum(row.discountPct),
      taxRate: qtyNum(row.taxRate),
      lineSubtotal: qtyNum(row.lineSubtotal),
      lineDiscount: qtyNum(row.lineDiscount),
      lineTotal: qtyNum(row.lineTotal),
      lineTax: qtyNum(row.lineTax),
      ...(row.extra || {}),
    }),
    product: row.product && typeof row.product === 'object'
      ? { _id: row.product.id, name: row.product.name, sku: row.product.sku, unit: row.product.unit }
      : row.productId,
  };
}

function quotationToApi(row) {
  if (!row) return null;
  const lines = mapLines(row, quotationLineToApi);
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    client: relationRef(row.client, row.clientId),
    quotationDate: row.quotationDate,
    expiryDate: row.expiryDate ?? null,
    status: row.status,
    currencyCode: row.currencyCode,
    baseCurrency: row.baseCurrency,
    exchangeRate: qtyNum(row.exchangeRate),
    subtotal: qtyNum(row.subtotal),
    totalDiscount: qtyNum(row.totalDiscount),
    taxAmount: qtyNum(row.taxAmount),
    totalAmount: qtyNum(row.totalAmount),
    subtotalBase: qtyNum(row.subtotalBase),
    totalAmountBase: qtyNum(row.totalAmountBase),
    terms: row.terms ?? null,
    notes: row.notes ?? null,
    customerAction: row.customerAction ?? {},
    convertedToInvoice: row.convertedToInvoiceId ?? null,
    convertedToSalesOrder: row.convertedToSalesOrderId ?? null,
    conversionDate: row.conversionDate ?? null,
    approvedBy: row.approvedById ?? null,
    approvedDate: row.approvedDate ?? null,
    createdBy: row.createdById ?? null,
    quotationNumber: row.referenceNo,
    validUntil: row.expiryDate ?? null,
    grandTotal: qtyNum(row.totalAmount),
    publicAcceptToken: row.customerAction?.publicAcceptToken ?? null,
    publicRejectToken: row.customerAction?.publicRejectToken ?? null,
    publicTokenExpiresAt: row.customerAction?.publicTokenExpiresAt ?? null,
    lines,
    ...mapTimestamps(row),
  };
}

// ── Invoice (hottest read path) ──────────────────────────────────────────────

function invoiceLineToApi(row) {
  if (!row) return null;
  const api = {
    ...lineBase(row, {
      productName: row.productName ?? null,
      productCode: row.productCode ?? null,
      description: row.description ?? null,
      qty: qtyNum(row.qty),
      quantity: qtyNum(row.qty),
      unit: row.unit ?? null,
      unitPrice: qtyNum(row.unitPrice),
      discountPct: qtyNum(row.discountPct),
      taxRate: qtyNum(row.taxRate),
      taxCode: row.taxCode,
      lineSubtotal: qtyNum(row.lineSubtotal),
      lineTax: qtyNum(row.lineTax),
      lineTotal: qtyNum(row.lineTotal),
      unitCost: moneyStr(row.unitCost),
      cogsAmount: moneyStr(row.cogsAmount),
      warehouse: row.warehouseId ?? null,
      qtyCredited: qtyNum(row.qtyCredited),
      itemCode: row.productCode ?? null,
      subtotal: qtyNum(row.lineSubtotal),
      taxAmount: qtyNum(row.lineTax),
      totalWithTax: qtyNum(row.lineTotal),
    }),
  };
  if (row.product && typeof row.product === 'object') {
    api.product = { _id: row.product.id, name: row.product.name, sku: row.product.sku, unit: row.product.unit };
  }
  return api;
}

function invoiceToApi(row) {
  if (!row) return null;
  const lines = mapLines(row, invoiceLineToApi);
  const linesSubtotal = lines.reduce((s, l) => s + (Number(l.lineSubtotal) || 0), 0);
  const linesTax = lines.reduce((s, l) => s + (Number(l.lineTax) || Number(l.taxAmount) || 0), 0);
  const linesTotal = lines.reduce((s, l) => s + (Number(l.lineTotal) || Number(l.totalWithTax) || 0), 0);
  const headerSubtotal = qtyNum(row.subtotal);
  const headerTax = qtyNum(row.taxAmount);
  const headerTotal = qtyNum(row.totalAmount);
  const subtotal = headerSubtotal > 0 ? headerSubtotal : linesSubtotal;
  const taxAmount = headerTax > 0 ? headerTax : linesTax;
  const totalAmount = headerTotal > 0 ? headerTotal : linesTotal;
  const amountPaid = qtyNum(row.amountPaid);
  const outstanding = Math.round(Math.max(0, totalAmount - amountPaid) * 100) / 100;
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    invoiceNumber: row.referenceNo,
    client: relationRef(row.client, row.clientId),
    customerTin: row.customerTin ?? null,
    customerName: row.customerName ?? null,
    customerAddress: row.customerAddress ?? null,
    quotation: row.quotationId ?? null,
    salesOrder: row.salesOrderId ?? null,
    deliveryNote: row.deliveryNoteId ?? null,
    status: row.status,
    currencyCode: row.currencyCode,
    currency: row.currencyCode,
    exchangeRate: qtyNum(row.exchangeRate),
    subtotal: moneyStr(subtotal),
    taxAmount: moneyStr(taxAmount),
    totalTax: moneyStr(taxAmount),
    totalAmount: moneyStr(totalAmount),
    grandTotal: moneyStr(totalAmount),
    amountPaid: moneyStr(amountPaid),
    amountOutstanding: moneyStr(outstanding),
    balance: moneyStr(outstanding),
    totalAEx: qtyNum(row.totalAEx),
    totalB18: qtyNum(row.totalB18),
    totalDiscount: qtyNum(row.totalDiscount),
    invoiceDate: row.invoiceDate,
    date: row.invoiceDate,
    dueDate: row.dueDate,
    paidDate: row.paidDate ?? null,
    revenueJournalEntry: row.revenueJournalEntryId ?? null,
    cogsJournalEntry: row.cogsJournalEntryId ?? null,
    stockDeducted: row.stockDeducted,
    autoConfirm: row.autoConfirm,
    generatedFromRecurring: row.generatedFromRecurringId ?? null,
    creditNotes: (row.creditNotes || []).map((cn) => (typeof cn === 'object' ? cn.id : cn)),
    payments: row.payments ?? [],
    ebm: row.ebm ?? {},
    notes: row.notes ?? null,
    createdBy: row.createdById ?? null,
    lines,
    items: lines,
    ...mapTimestamps(row),
  };
}

async function invoiceTranslateCreate(data) {
  const base = tenantCreateBase(data);
  const lines = Array.isArray(data.lines || data.items) ? (data.lines || data.items) : [];

  const mappedLines = lines.map((line, idx) => {
    const qty = Number(line.qty ?? line.quantity ?? 0) || 0;
    const unitPrice = Number(line.unitPrice ?? 0) || 0;
    const discountPct = Number(line.discountPct ?? line.discount ?? 0) || 0;
    const taxRate = Number(line.taxRate ?? 0) || 0;
    const lineSubtotal = Number(
      line.lineSubtotal ?? line.subtotal ?? (qty * unitPrice * (1 - discountPct / 100)),
    ) || 0;
    const lineTax = Number(line.lineTax ?? line.taxAmount ?? (lineSubtotal * taxRate / 100)) || 0;
    const lineTotal = Number(line.lineTotal ?? line.totalWithTax ?? (lineSubtotal + lineTax)) || 0;
    return {
      id: toIdString(line.lineId || line._id) || generateObjectId(),
      companyId: base.companyId,
      lineOrder: idx,
      lineId: toIdString(line.lineId || line._id) || null,
      productId: toIdString(line.product),
      productName: line.productName ?? null,
      productCode: line.productCode ?? line.itemCode ?? null,
      description: line.description ?? null,
      qty,
      unit: line.unit ?? null,
      unitPrice,
      discountPct,
      taxRate,
      taxCode: line.taxCode ?? 'A',
      lineSubtotal,
      lineTax,
      lineTotal,
      unitCost: line.unitCost ?? 0,
      cogsAmount: line.cogsAmount ?? 0,
      warehouseId: line.warehouse ? toIdString(line.warehouse) : null,
      qtyCredited: line.qtyCredited ?? 0,
    };
  });

  const linesSubtotal = mappedLines.reduce((s, l) => s + Number(l.lineSubtotal || 0), 0);
  const linesTax = mappedLines.reduce((s, l) => s + Number(l.lineTax || 0), 0);
  const linesTotal = mappedLines.reduce((s, l) => s + Number(l.lineTotal || 0), 0);

  const subtotal = Number(data.subtotal) > 0 ? Number(data.subtotal) : linesSubtotal;
  const taxAmount = Number(data.taxAmount ?? data.totalTax) > 0
    ? Number(data.taxAmount ?? data.totalTax)
    : linesTax;
  const totalAmount = Number(data.totalAmount ?? data.grandTotal) > 0
    ? Number(data.totalAmount ?? data.grandTotal)
    : linesTotal;
  const amountPaid = Number(data.amountPaid ?? 0) || 0;
  const amountOutstanding = data.amountOutstanding != null || data.balance != null
    ? Number(data.amountOutstanding ?? data.balance)
    : Math.max(0, totalAmount - amountPaid);

  return {
    ...base,
    referenceNo: data.referenceNo || data.invoiceNumber,
    clientId: toIdString(data.client),
    customerTin: data.customerTin ?? null,
    customerName: data.customerName ?? null,
    customerAddress: data.customerAddress ?? null,
    quotationId: data.quotation ? toIdString(data.quotation) : null,
    salesOrderId: data.salesOrder ? toIdString(data.salesOrder) : null,
    deliveryNoteId: data.deliveryNote ? toIdString(data.deliveryNote) : null,
    status: data.status || 'draft',
    currencyCode: data.currencyCode || data.currency || 'RWF',
    exchangeRate: data.exchangeRate ?? 1,
    subtotal: moneyStr(subtotal),
    taxAmount: moneyStr(taxAmount),
    totalAmount: moneyStr(totalAmount),
    amountPaid: moneyStr(amountPaid),
    amountOutstanding: moneyStr(amountOutstanding),
    invoiceDate: data.invoiceDate || data.date || new Date(),
    dueDate: data.dueDate || new Date(),
    payments: data.payments ?? [],
    ebm: data.ebm ?? {},
    notes: data.notes ?? null,
    lines: mappedLines.length ? { create: mappedLines } : undefined,
  };
}

function invoiceTranslateUpdate(update = {}) {
  const data = mergeUpdatePayload(update);
  const out = {};
  const map = {
    referenceNo: 'referenceNo', status: 'status', client: 'clientId',
    customerTin: 'customerTin', customerName: 'customerName', customerAddress: 'customerAddress',
    quotation: 'quotationId', salesOrder: 'salesOrderId', deliveryNote: 'deliveryNoteId',
    currencyCode: 'currencyCode', currency: 'currencyCode', exchangeRate: 'exchangeRate',
    subtotal: 'subtotal', taxAmount: 'taxAmount', totalAmount: 'totalAmount',
    amountPaid: 'amountPaid', amountOutstanding: 'amountOutstanding',
    invoiceDate: 'invoiceDate', dueDate: 'dueDate', paidDate: 'paidDate',
    payments: 'payments', ebm: 'ebm', notes: 'notes',
    revenueJournalEntry: 'revenueJournalEntryId', cogsJournalEntry: 'cogsJournalEntryId',
    stockDeducted: 'stockDeducted', autoConfirm: 'autoConfirm',
    balance: 'amountOutstanding',
  };
  const idTargets = new Set([
    'clientId', 'quotationId', 'salesOrderId', 'deliveryNoteId',
    'revenueJournalEntryId', 'cogsJournalEntryId',
  ]);
  for (const [k, t] of Object.entries(map)) {
    if (data[k] !== undefined) {
      out[t] = idTargets.has(t) && data[k] ? toIdString(data[k]) : data[k];
    }
  }
  // Merge dotted ebm.* patches (legacy Mongo-style nested $set paths).
  const ebmPatches = {};
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith('ebm.')) ebmPatches[k.slice(4)] = v;
  }
  if (Object.keys(ebmPatches).length) {
    const base = out.ebm && typeof out.ebm === 'object' && !Array.isArray(out.ebm) ? out.ebm : {};
    out.ebm = { ...base, ...ebmPatches };
  }
  return out;
}

// ── SalesOrder ─────────────────────────────────────────────────────────────

function salesOrderLineToApi(row) {
  if (!row) return null;
  const trace = row.traceability || {};
  const base = lineBase(row, {
    description: row.description ?? null,
    qty: qtyNum(row.qty),
    qtyReserved: qtyNum(row.qtyReserved),
    qtyPicked: qtyNum(row.qtyPicked),
    qtyDelivered: qtyNum(row.qtyDelivered),
    qtyInvoiced: qtyNum(row.qtyInvoiced),
    unit: row.unit ?? null,
    unitPrice: qtyNum(row.unitPrice),
    discountPct: qtyNum(row.discountPct),
    taxRate: qtyNum(row.taxRate),
    lineTotal: qtyNum(row.lineTotal),
    lineTax: qtyNum(row.lineTax),
    warehouse: row.warehouseId ?? null,
    batchId: row.batchId ?? null,
    serialNumbers: row.serialNumbers ?? [],
    status: row.status,
    deliveryNoteLines: trace.deliveryNoteLines ?? [],
    invoiceLines: trace.invoiceLines ?? [],
  });
  if (row.product && typeof row.product === 'object') {
    base.product = relationRef(row.product, row.productId);
  }
  return base;
}

function salesOrderToApi(row) {
  if (!row) return null;
  const lines = mapLines(row, salesOrderLineToApi);
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    client: relationRef(row.client, row.clientId),
    quotation: relationRef(row.quotation, row.quotationId),
    orderDate: row.orderDate,
    expectedDate: row.expectedDate ?? null,
    status: row.status,
    currencyCode: row.currencyCode,
    exchangeRate: qtyNum(row.exchangeRate),
    subtotal: qtyNum(row.subtotal),
    taxAmount: qtyNum(row.taxAmount),
    totalAmount: qtyNum(row.totalAmount),
    fulfillmentStatus: row.fulfillmentStatus,
    fulfillmentPercent: qtyNum(row.fulfillmentPercent),
    stockReserved: row.stockReserved,
    isBackorder: row.isBackorder,
    parentOrder: row.parentOrderId ?? null,
    deliveryNotes: row.deliveryNotes ?? [],
    invoices: row.invoices ?? [],
    pickPackId: row.pickPackId ?? null,
    notes: row.notes ?? null,
    createdBy: row.createdById ?? null,
    lines,
    ...mapTimestamps(row),
  };
}

// ── PurchaseOrder / GRN / AP ───────────────────────────────────────────────

function purchaseOrderLineToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    product: row.product && typeof row.product === 'object'
      ? relationRef(row.product, row.productId)
      : row.productId,
    qtyOrdered: qtyNum(row.qtyOrdered),
    qtyReceived: qtyNum(row.qtyReceived),
    unitCost: qtyNum(row.unitCost),
    taxRate: qtyNum(row.taxRate),
    taxAmount: qtyNum(row.taxAmount),
    lineTotal: qtyNum(row.lineTotal),
    ...(row.budgetRefs || {}),
  };
}

function purchaseOrderToApi(row) {
  if (!row) return null;
  const lines = mapLines(row, purchaseOrderLineToApi);
  const linesSubtotal = lines.reduce(
    (s, l) => s + (Number(l.qtyOrdered) || 0) * (Number(l.unitCost) || 0),
    0,
  );
  const linesTax = lines.reduce((s, l) => s + (Number(l.taxAmount) || 0), 0);
  const linesTotal = lines.reduce(
    (s, l) => s + (Number(l.lineTotal) || 0),
    0,
  ) || (linesSubtotal + linesTax);
  const headerSubtotal = qtyNum(row.subtotal);
  const headerTax = qtyNum(row.taxAmount);
  const headerTotal = qtyNum(row.totalAmount);
  const subtotal = headerSubtotal > 0 ? headerSubtotal : linesSubtotal;
  const taxAmount = headerTax > 0 ? headerTax : linesTax;
  const totalAmount = headerTotal > 0 ? headerTotal : linesTotal;
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    supplier: relationRef(row.supplier, row.supplierId),
    warehouse: relationRef(row.warehouse, row.warehouseId),
    orderDate: row.orderDate,
    expectedDeliveryDate: row.expectedDeliveryDate ?? null,
    status: row.status,
    source: row.source,
    autoReorderProduct: row.autoReorderProductId ?? null,
    currencyCode: row.currencyCode,
    exchangeRate: qtyNum(row.exchangeRate),
    subtotal,
    taxAmount,
    totalAmount,
    amountPaid: qtyNum(row.amountPaid),
    balance: qtyNum(row.balance) > 0 || qtyNum(row.amountPaid) > 0
      ? qtyNum(row.balance)
      : Math.max(0, totalAmount - qtyNum(row.amountPaid)),
    paymentStatus: row.paymentStatus,
    payments: row.payments ?? [],
    freight: row.freight ?? {},
    ebm: row.ebm ?? {},
    notes: row.notes ?? null,
    approvedBy: row.approvedById ?? null,
    approvedAt: row.approvedAt ?? null,
    createdBy: row.createdById ?? null,
    lines,
    linesCount: lines.length,
    ...mapTimestamps(row),
  };
}

function grnLineToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    purchaseOrderLine: row.purchaseOrderLineId ?? null,
    product: row.product && typeof row.product === 'object'
      ? relationRef(row.product, row.productId)
      : row.productId,
    qtyReceived: qtyNum(row.qtyReceived),
    unitCost: qtyNum(row.unitCost),
    taxRate: qtyNum(row.taxRate),
    batchNo: row.batchNo ?? null,
    serialNumbers: row.serialNumbers ?? [],
    ...(row.extra || {}),
  };
}

function grnToApi(row) {
  if (!row) return null;
  const lines = mapLines(row, grnLineToApi);
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    purchaseOrder: relationRef(row.purchaseOrder, row.purchaseOrderId),
    warehouse: relationRef(row.warehouse, row.warehouseId),
    supplier: relationRef(row.supplier, row.supplierId),
    receivedDate: row.receivedDate,
    status: row.status,
    supplierInvoiceNo: row.supplierInvoiceNo ?? null,
    totalAmount: moneyStr(row.totalAmount),
    balance: moneyStr(row.balance),
    amountPaid: moneyStr(row.amountPaid),
    paymentStatus: row.paymentStatus,
    paymentDueDate: row.paymentDueDate ?? null,
    journalEntry: row.journalEntryId ?? null,
    freight: row.freight ?? {},
    ebm: row.ebm ?? {},
    ebmImportReference: row.ebmImportReference ?? null,
    createdBy: row.createdById ?? null,
    confirmedBy: row.confirmedById ?? null,
    confirmedAt: row.confirmedAt ?? null,
    lines,
    ...mapTimestamps(row),
  };
}

function arReceiptToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    client: relationRef(row.client, row.clientId),
    receiptDate: row.receiptDate,
    paymentMethod: row.paymentMethod,
    bankAccount: row.bankAccountId ?? null,
    amountReceived: moneyStr(row.amountReceived),
    currencyCode: row.currencyCode,
    exchangeRate: qtyNum(row.exchangeRate),
    reference: row.reference ?? null,
    status: row.status,
    journalEntry: row.journalEntryId ?? null,
    unallocatedAmount: moneyStr(row.unallocatedAmount),
    createdBy: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

function arReceiptAllocationToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    receipt: row.receiptId,
    invoice: row.invoiceId,
    amountAllocated: moneyStr(row.amountAllocated),
    createdBy: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

function apPaymentToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    supplier: relationRef(row.supplier, row.supplierId),
    paymentDate: row.paymentDate,
    paymentMethod: row.paymentMethod,
    bankAccount: row.bankAccountId ?? null,
    amountPaid: moneyStr(row.amountPaid),
    currencyCode: row.currencyCode,
    exchangeRate: qtyNum(row.exchangeRate),
    status: row.status,
    journalEntry: row.journalEntryId ?? null,
    unallocatedAmount: moneyStr(row.unallocatedAmount),
    createdBy: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

function apPaymentAllocationToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    payment: row.paymentId,
    grn: row.grnId,
    amountAllocated: moneyStr(row.amountAllocated),
    createdBy: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

function creditNoteLineTaxParts(lineTotal, taxRate) {
  const total = qtyNum(lineTotal);
  const rate = qtyNum(taxRate);
  if (total <= 0 || rate <= 0) return { lineSubtotal: total, lineTax: 0 };
  const lineSubtotal = total / (1 + rate / 100);
  return { lineSubtotal, lineTax: total - lineSubtotal };
}

function creditNoteToApi(row) {
  if (!row) return null;
  const lines = mapLines(row, (l) => {
    const lineTotal = qtyNum(l.lineTotal);
    const taxRate = qtyNum(l.taxRate);
    const { lineSubtotal, lineTax } = creditNoteLineTaxParts(lineTotal, taxRate);
    return {
      _id: l.id,
      invoiceLineId: l.invoiceLineId ?? null,
      product: relationRef(l.product, l.productId),
      productName: l.productName ?? (l.product && l.product.name) ?? null,
      productCode: (l.product && l.product.sku) ?? null,
      quantity: qtyNum(l.quantity),
      originalQty: qtyNum(l.originalQty),
      unitPrice: qtyNum(l.unitPrice),
      unitCost: qtyNum(l.unitCost),
      taxRate,
      lineSubtotal,
      lineTax,
      lineTotal,
      returnToWarehouse: l.returnToWarehouseId ?? null,
      batchId: l.batchId ?? null,
      serialNumbers: l.serialNumbers ?? [],
    };
  });
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    creditNoteNumber: row.referenceNo,
    invoice: relationRef(row.invoice, row.invoiceId),
    client: relationRef(row.client, row.clientId),
    creditDate: row.creditDate,
    reason: row.reason ?? null,
    type: row.type,
    status: row.status,
    currencyCode: row.currencyCode,
    subtotal: qtyNum(row.subtotal),
    taxAmount: qtyNum(row.taxAmount),
    totalAmount: qtyNum(row.totalAmount),
    grandTotal: qtyNum(row.totalAmount),
    stockReversed: row.stockReversed,
    payments: row.payments ?? [],
    ebm: row.ebm ?? {},
    lines,
    items: lines,
    createdBy: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

function deliveryNoteToApi(row) {
  if (!row) return null;
  const lines = mapLines(row, (l) => {
    const qtyToDeliver = qtyNum(l.qtyToDeliver);
    const unitPrice = qtyNum(l.unitPrice);
    const unitCost = qtyNum(l.unitCost);
    const lineTotal = qtyNum(l.lineTotal) || (unitPrice * qtyToDeliver) || (unitCost * qtyToDeliver);
    const product = l.product && typeof l.product === 'object'
      ? relationRef(l.product, l.productId)
      : l.productId;
    const productName = l.productName
      || (product && typeof product === 'object' ? product.name : null)
      || null;
    return {
      _id: l.id,
      invoiceLineId: l.invoiceLineId ?? null,
      product,
      productName,
      productCode: l.productCode ?? (product && typeof product === 'object' ? product.sku : null) ?? null,
      description: productName,
      unit: l.unit ?? (product && typeof product === 'object' ? product.unit : null) ?? null,
      qtyToDeliver,
      quantity: qtyToDeliver,
      deliveredQty: qtyNum(l.deliveredQty),
      batchId: l.batchId ?? null,
      serialNumbers: l.serialNumbers ?? [],
      unitCost,
      unitPrice,
      lineTotal,
      notes: l.notes ?? null,
    };
  });
  const grandTotal = lines.reduce((sum, l) => sum + (Number(l.lineTotal) || 0), 0);
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    salesOrder: relationRef(row.salesOrder, row.salesOrderId),
    pickPack: row.pickPackId ?? null,
    invoice: relationRef(row.invoice, row.invoiceId),
    client: relationRef(row.client, row.clientId),
    warehouse: relationRef(row.warehouse, row.warehouseId),
    quotation: relationRef(row.quotation, row.quotationId),
    sourceType: row.sourceType ?? null,
    deliveryDate: row.deliveryDate,
    status: row.status,
    stockDeducted: row.stockDeducted,
    notes: row.notes ?? null,
    lines,
    items: lines,
    itemsCount: lines.length,
    grandTotal,
    totalAmount: grandTotal,
    createdBy: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

// ── PickPack ───────────────────────────────────────────────────────────────

function pickPackLineToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    salesOrderLineId: row.salesOrderLineId,
    product: row.product && typeof row.product === 'object'
      ? relationRef(row.product, row.productId)
      : row.productId,
    warehouse: row.warehouse && typeof row.warehouse === 'object'
      ? relationRef(row.warehouse, row.warehouseId)
      : (row.warehouseId ?? null),
    location: row.location ?? null,
    qtyToPick: qtyNum(row.qtyToPick),
    qtyPicked: qtyNum(row.qtyPicked),
    qtyPacked: qtyNum(row.qtyPacked),
    batchId: row.batchId ?? null,
    batchNo: row.batchNo ?? null,
    serialNumbers: row.serialNumbers ?? [],
    unit: row.unit ?? null,
    status: row.status,
    pickedBy: row.pickedById ?? null,
    pickedAt: row.pickedAt ?? null,
    pickingNotes: row.pickingNotes ?? null,
    packedBy: row.packedById ?? null,
    packedAt: row.packedAt ?? null,
    packingNotes: row.packingNotes ?? null,
    issues: row.issues ?? [],
  };
}

function pickPackToApi(row) {
  if (!row) return null;
  const lines = mapLines(row, pickPackLineToApi);
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    salesOrder: relationRef(row.salesOrder, row.salesOrderId),
    client: relationRef(row.client, row.clientId),
    warehouse: relationRef(row.warehouse, row.warehouseId),
    status: row.status,
    assignedTo: row.assignedToId ?? null,
    assignedAt: row.assignedAt ?? null,
    pickingStartedAt: row.pickingStartedAt ?? null,
    pickingCompletedAt: row.pickingCompletedAt ?? null,
    packingStartedAt: row.packingStartedAt ?? null,
    packingCompletedAt: row.packingCompletedAt ?? null,
    priority: row.priority,
    notes: row.notes ?? null,
    packageCount: row.packageCount ?? 0,
    packageType: row.packageType ?? 'box',
    totalWeight: qtyNum(row.totalWeight),
    shippingMethod: row.shippingMethod ?? null,
    trackingNumber: row.trackingNumber ?? null,
    deliveryNote: row.deliveryNoteId ?? null,
    createdBy: row.createdById ?? null,
    cancelledBy: row.cancelledById ?? null,
    cancelledAt: row.cancelledAt ?? null,
    cancellationReason: row.cancellationReason ?? null,
    lines,
    ...mapTimestamps(row),
  };
}

function purchaseToApi(row) {
  if (!row) return null;
  const lines = mapLines(row, (l) => {
    const qty = qtyNum(l.qty);
    const unitCost = qtyNum(l.unitCost);
    const taxRate = qtyNum(l.taxRate);
    const net = qty * unitCost;
    const lineTotal = qtyNum(l.lineTotal) || (net * (1 + taxRate / 100));
    const taxAmount = Math.max(0, lineTotal - net);
    return {
      _id: l.id,
      product: l.product && typeof l.product === 'object'
        ? relationRef(l.product, l.productId)
        : l.productId,
      // Legacy controllers/UI use `quantity`; Prisma field is `qty`
      qty,
      quantity: qty,
      unitCost,
      taxRate,
      taxAmount,
      lineTotal,
      totalWithTax: lineTotal,
      ...(l.extra || {}),
    };
  });
  const subtotal = qtyNum(row.subtotal);
  const taxAmount = qtyNum(row.taxAmount);
  const totalAmount = qtyNum(row.totalAmount) || (subtotal + taxAmount);
  return {
    _id: row.id,
    company: row.companyId,
    purchaseNumber: row.purchaseNumber,
    supplier: relationRef(row.supplier, row.supplierId),
    supplierInvoiceNumber: row.supplierInvoiceNumber ?? null,
    warehouse: relationRef(row.warehouse, row.warehouseId),
    status: row.status,
    currency: row.currency,
    subtotal,
    taxAmount,
    totalTax: taxAmount,
    totalAmount,
    // Legacy aliases used by journal/email/receive flows
    roundedAmount: totalAmount,
    grandTotal: totalAmount,
    payments: row.payments ?? [],
    amountPaid: Array.isArray(row.payments)
      ? row.payments.reduce((s, p) => s + qtyNum(p.amount), 0)
      : 0,
    balance: totalAmount,
    purchaseDate: row.purchaseDate,
    stockAdded: row.stockAdded,
    ebm: row.ebm ?? {},
    items: lines,
    lines,
    createdBy: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

function genericTranslateCreate(data, headerMap, lineMapper) {
  const base = tenantCreateBase(data);
  const lines = Array.isArray(data.lines || data.items) ? (data.lines || data.items) : [];
  const header = {};
  for (const [mongoKey, prismaKey] of Object.entries(headerMap)) {
    if (data[mongoKey] !== undefined) {
      header[prismaKey] = prismaKey.endsWith('Id') && data[mongoKey]
        ? toIdString(data[mongoKey]) : data[mongoKey];
    }
  }
  return {
    ...base,
    ...header,
    lines: lines.length && lineMapper
      ? { create: lines.map((l, idx) => lineMapper(l, idx, base.companyId)) }
      : undefined,
  };
}

/** HTML date inputs and API payloads often send YYYY-MM-DD; Prisma needs Date objects. */
function coerceDateTime(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(`${s}T00:00:00.000Z`);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function coerceQuotationDates(data) {
  if (!data || typeof data !== 'object') return data;
  const next = { ...data };
  if (next.quotationDate != null) {
    next.quotationDate = coerceDateTime(next.quotationDate) ?? new Date();
  }
  if (next.expiryDate != null) {
    next.expiryDate = coerceDateTime(next.expiryDate);
  }
  return next;
}

function pickHeader(data, headerMap, idFields = []) {
  const out = {};
  for (const [mongoKey, prismaKey] of Object.entries(headerMap)) {
    if (data[mongoKey] !== undefined) {
      out[prismaKey] = idFields.includes(prismaKey) && data[mongoKey]
        ? toIdString(data[mongoKey]) : data[mongoKey];
    }
  }
  return out;
}

function headerTranslateCreate(data, headerMap, idFields = []) {
  const base = tenantCreateBase(data);
  return { ...base, ...pickHeader(data, headerMap, idFields) };
}

function genericTranslateUpdate(headerMap, idFields = []) {
  return (update = {}) => pickHeader(mergeUpdatePayload(update), headerMap, idFields);
}

function defaultLineCreate(line, idx, companyId, extra = {}) {
  return {
    id: toIdString(line._id) || generateObjectId(),
    companyId,
    lineOrder: idx,
    productId: toIdString(line.product),
    ...extra,
  };
}

// ── RecurringInvoice / Run / PurchaseReturn / FreightBill ───────────────────

function recurringInvoiceLineToApi(row) {
  if (!row) return null;
  const qty = qtyNum(row.qty);
  const unitPrice = qtyNum(row.unitPrice);
  const discountPct = qtyNum(row.discountPct);
  const taxRate = qtyNum(row.taxRate);
  const lineSubtotal = qty * unitPrice * (1 - discountPct / 100);
  const lineTax = lineSubtotal * (taxRate / 100);
  const lineTotal = lineSubtotal + lineTax;
  const productName = row.productName ?? (row.product && row.product.name) ?? null;
  const productCode = row.productCode ?? (row.product && row.product.sku) ?? null;
  return {
    ...lineBase(row, {
      description: row.description ?? null,
      productName,
      productCode,
      qty,
      quantity: qty,
      unitPrice,
      discountPct,
      taxRate,
      lineSubtotal,
      lineTax,
      lineTotal,
      warehouse: row.warehouseId ?? null,
    }),
    product: relationRef(row.product, row.productId),
  };
}

function recurringInvoiceToApi(row) {
  if (!row) return null;
  const lines = mapLines(row, recurringInvoiceLineToApi);
  const subtotal = lines.reduce((sum, line) => sum + (line.lineSubtotal || 0), 0);
  const taxAmount = lines.reduce((sum, line) => sum + (line.lineTax || 0), 0);
  const totalAmount = lines.reduce((sum, line) => sum + (line.lineTotal || 0), 0);
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    client: relationRef(row.client, row.clientId),
    schedule: row.schedule ?? {},
    startDate: row.startDate,
    endDate: row.endDate ?? null,
    nextRunDate: row.nextRunDate ?? null,
    status: row.status,
    autoConfirm: row.autoConfirm,
    currencyCode: row.currencyCode,
    notes: row.notes ?? null,
    lastRunAt: row.lastRunAt ?? null,
    subtotal,
    taxAmount,
    totalAmount,
    createdBy: relationRef(row.createdBy, row.createdById),
    lines,
    ...mapTimestamps(row),
  };
}

function recurringInvoiceRunToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    template: row.recurringInvoiceId,
    recurringInvoice: row.recurringInvoiceId,
    runDate: row.runDate,
    invoice: relationRef(row.invoice, row.invoiceId),
    status: row.status,
    errorMessage: row.errorMessage ?? null,
    createdAt: row.createdAt,
  };
}

function purchaseReturnLineToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    grnLine: row.grnLineId ?? null,
    qtyReturned: qtyNum(row.qtyReturned),
    unitCost: qtyNum(row.unitCost),
    product: row.product && typeof row.product === 'object'
      ? { _id: row.product.id, name: row.product.name, sku: row.product.sku, unit: row.product.unit }
      : row.productId,
  };
}

function purchaseReturnToApi(row) {
  if (!row) return null;
  const lines = mapLines(row, purchaseReturnLineToApi);
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    grn: relationRef(row.grn, row.grnId),
    supplier: relationRef(row.supplier, row.supplierId),
    warehouse: relationRef(row.warehouse, row.warehouseId),
    returnDate: row.returnDate,
    reason: row.reason ?? null,
    status: row.status,
    totalAmount: moneyStr(row.totalAmount),
    journalEntry: row.journalEntryId ?? null,
    refundMethod: row.refundMethod ?? null,
    bankAccountId: row.bankAccountId ?? null,
    refundJournalEntry: row.refundJournalEntryId ?? null,
    createdBy: row.createdById ?? null,
    lines,
    ...mapTimestamps(row),
  };
}

function freightBillToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    supplier: relationRef(row.supplier, row.supplierId),
    carrierName: row.carrierName ?? null,
    amount: moneyStr(row.amount),
    account: row.account ?? null,
    invoiceDate: row.invoiceDate ?? null,
    paymentMethod: row.paymentMethod ?? null,
    status: row.status,
    grnMatches: row.grnMatches ?? [],
    journalEntry: row.journalEntryId ?? null,
    createdBy: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

// ── Translate: Quotation ─────────────────────────────────────────────────────

const QUOTATION_HEADER = {
  referenceNo: 'referenceNo',
  client: 'clientId',
  status: 'status',
  quotationDate: 'quotationDate',
  expiryDate: 'expiryDate',
  currencyCode: 'currencyCode',
  baseCurrency: 'baseCurrency',
  exchangeRate: 'exchangeRate',
  subtotal: 'subtotal',
  totalDiscount: 'totalDiscount',
  taxAmount: 'taxAmount',
  totalAmount: 'totalAmount',
  subtotalBase: 'subtotalBase',
  totalAmountBase: 'totalAmountBase',
  terms: 'terms',
  notes: 'notes',
  customerAction: 'customerAction',
};

function quotationTranslateCreate(data) {
  const payload = coerceQuotationDates(data);
  return genericTranslateCreate(payload, QUOTATION_HEADER, (line, idx, companyId) =>
    defaultLineCreate(line, idx, companyId, {
      lineId: toIdString(line.lineId || line._id) || null,
      productName: line.productName ?? null,
      productSku: line.productSku ?? null,
      productUnit: line.productUnit ?? null,
      description: line.description ?? null,
      qty: line.qty ?? line.quantity ?? 0,
      unit: line.unit ?? null,
      unitPrice: line.unitPrice ?? 0,
      discountPct: line.discountPct ?? line.discount ?? 0,
      taxRate: line.taxRate ?? 0,
      lineSubtotal: line.lineSubtotal ?? line.subtotal ?? 0,
      lineDiscount: line.lineDiscount ?? 0,
      lineTotal: line.lineTotal ?? 0,
      lineTax: line.lineTax ?? line.taxAmount ?? 0,
    }));
}

const quotationTranslateUpdateHeader = genericTranslateUpdate(QUOTATION_HEADER, ['clientId']);
const quotationTranslateUpdate = (update = {}) =>
  coerceQuotationDates(quotationTranslateUpdateHeader(update));

// ── Translate: SalesOrder ────────────────────────────────────────────────────

const SALES_ORDER_HEADER = {
  referenceNo: 'referenceNo',
  client: 'clientId',
  quotation: 'quotationId',
  status: 'status',
  orderDate: 'orderDate',
  expectedDate: 'expectedDate',
  currencyCode: 'currencyCode',
  exchangeRate: 'exchangeRate',
  subtotal: 'subtotal',
  taxAmount: 'taxAmount',
  totalAmount: 'totalAmount',
  fulfillmentStatus: 'fulfillmentStatus',
  fulfillmentPercent: 'fulfillmentPercent',
  stockReserved: 'stockReserved',
  isBackorder: 'isBackorder',
  pickPackId: 'pickPackId',
  notes: 'notes',
};

function salesOrderTranslateCreate(data) {
  return genericTranslateCreate(data, SALES_ORDER_HEADER, (line, idx, companyId) =>
    defaultLineCreate(line, idx, companyId, {
      lineId: toIdString(line.lineId || line._id) || null,
      description: line.description ?? null,
      qty: line.qty ?? line.quantity ?? 0,
      qtyReserved: line.qtyReserved ?? 0,
      qtyPicked: line.qtyPicked ?? 0,
      qtyDelivered: line.qtyDelivered ?? 0,
      qtyInvoiced: line.qtyInvoiced ?? 0,
      unit: line.unit ?? null,
      unitPrice: line.unitPrice ?? 0,
      discountPct: line.discountPct ?? line.discount ?? 0,
      taxRate: line.taxRate ?? 0,
      lineTotal: line.lineTotal ?? 0,
      lineTax: line.lineTax ?? line.taxAmount ?? 0,
      warehouseId: line.warehouse ? toIdString(line.warehouse) : null,
      batchId: line.batchId ? toIdString(line.batchId) : null,
      serialNumbers: line.serialNumbers ?? [],
      status: line.status ?? 'pending',
      traceability: {
        deliveryNoteLines: line.deliveryNoteLines ?? [],
        invoiceLines: line.invoiceLines ?? [],
      },
    }));
}

const salesOrderTranslateUpdate = genericTranslateUpdate(SALES_ORDER_HEADER, ['clientId', 'quotationId']);

// ── Translate: CreditNote ────────────────────────────────────────────────────

const CREDIT_NOTE_HEADER = {
  referenceNo: 'referenceNo',
  invoice: 'invoiceId',
  client: 'clientId',
  status: 'status',
  creditDate: 'creditDate',
  reason: 'reason',
  type: 'type',
  currencyCode: 'currencyCode',
  subtotal: 'subtotal',
  taxAmount: 'taxAmount',
  totalAmount: 'totalAmount',
};

function creditNoteTranslateCreate(data) {
  return genericTranslateCreate(data, CREDIT_NOTE_HEADER, (line, idx, companyId) =>
    defaultLineCreate(line, idx, companyId, {
      invoiceLineId: line.invoiceLineId ? toIdString(line.invoiceLineId) : null,
      productName: line.productName ?? null,
      quantity: line.quantity ?? line.qty ?? 0,
      originalQty: line.originalQty ?? 0,
      unitPrice: line.unitPrice ?? 0,
      unitCost: line.unitCost ?? 0,
      taxRate: line.taxRate ?? 0,
      lineTotal: line.lineTotal ?? 0,
      returnToWarehouseId: line.returnToWarehouse ? toIdString(line.returnToWarehouse) : null,
    }));
}

const creditNoteTranslateUpdate = genericTranslateUpdate(CREDIT_NOTE_HEADER, ['invoiceId', 'clientId']);

// ── Translate: DeliveryNote ──────────────────────────────────────────────────

const DELIVERY_NOTE_HEADER = {
  referenceNo: 'referenceNo',
  salesOrder: 'salesOrderId',
  pickPack: 'pickPackId',
  invoice: 'invoiceId',
  client: 'clientId',
  warehouse: 'warehouseId',
  quotation: 'quotationId',
  status: 'status',
  deliveryDate: 'deliveryDate',
  notes: 'notes',
  sourceType: 'sourceType',
};

function deliveryNoteTranslateCreate(data) {
  return genericTranslateCreate(data, DELIVERY_NOTE_HEADER, (line, idx, companyId) =>
    defaultLineCreate(line, idx, companyId, {
      invoiceLineId: line.invoiceLineId ? toIdString(line.invoiceLineId) : null,
      productName: line.productName ?? null,
      productCode: line.productCode ?? null,
      unit: line.unit ?? null,
      qtyToDeliver: line.qtyToDeliver ?? line.qty ?? 0,
      deliveredQty: line.deliveredQty ?? 0,
      unitCost: line.unitCost ?? 0,
      unitPrice: line.unitPrice ?? 0,
      lineTotal: line.lineTotal ?? 0,
      notes: line.notes ?? null,
    }));
}

const deliveryNoteTranslateUpdate = genericTranslateUpdate(
  DELIVERY_NOTE_HEADER,
  ['salesOrderId', 'pickPackId', 'invoiceId', 'clientId', 'warehouseId', 'quotationId'],
);

// ── Translate: PickPack ──────────────────────────────────────────────────────

const PICK_PACK_HEADER = {
  referenceNo: 'referenceNo',
  salesOrder: 'salesOrderId',
  client: 'clientId',
  warehouse: 'warehouseId',
  status: 'status',
  assignedTo: 'assignedToId',
  assignedAt: 'assignedAt',
  pickingStartedAt: 'pickingStartedAt',
  pickingCompletedAt: 'pickingCompletedAt',
  packingStartedAt: 'packingStartedAt',
  packingCompletedAt: 'packingCompletedAt',
  priority: 'priority',
  notes: 'notes',
  packageCount: 'packageCount',
  packageType: 'packageType',
  totalWeight: 'totalWeight',
  shippingMethod: 'shippingMethod',
  trackingNumber: 'trackingNumber',
  deliveryNote: 'deliveryNoteId',
  cancelledBy: 'cancelledById',
  cancelledAt: 'cancelledAt',
  cancellationReason: 'cancellationReason',
};

function pickPackTranslateCreate(data) {
  return genericTranslateCreate(data, PICK_PACK_HEADER, (line, idx, companyId) =>
    defaultLineCreate(line, idx, companyId, {
      salesOrderLineId: String(line.salesOrderLineId || line.lineId || ''),
      warehouseId: line.warehouse ? toIdString(line.warehouse) : null,
      location: line.location ?? null,
      qtyToPick: line.qtyToPick ?? 0,
      qtyPicked: line.qtyPicked ?? 0,
      qtyPacked: line.qtyPacked ?? 0,
      batchId: line.batchId ? toIdString(line.batchId) : null,
      batchNo: line.batchNo ?? null,
      serialNumbers: line.serialNumbers ?? [],
      unit: line.unit ?? null,
      status: line.status ?? 'pending',
      pickedById: line.pickedBy ? toIdString(line.pickedBy) : null,
      pickedAt: line.pickedAt ?? null,
      pickingNotes: line.pickingNotes ?? null,
      packedById: line.packedBy ? toIdString(line.packedBy) : null,
      packedAt: line.packedAt ?? null,
      packingNotes: line.packingNotes ?? null,
      issues: line.issues ?? [],
    }));
}

const pickPackTranslateUpdate = genericTranslateUpdate(
  PICK_PACK_HEADER,
  ['salesOrderId', 'clientId', 'warehouseId', 'assignedToId', 'deliveryNoteId', 'cancelledById'],
);

// ── Translate: ARReceipt / Allocation ────────────────────────────────────────

const AR_RECEIPT_HEADER = {
  referenceNo: 'referenceNo',
  client: 'clientId',
  status: 'status',
  receiptDate: 'receiptDate',
  paymentMethod: 'paymentMethod',
  bankAccount: 'bankAccountId',
  amountReceived: 'amountReceived',
  currencyCode: 'currencyCode',
  exchangeRate: 'exchangeRate',
  reference: 'reference',
  unallocatedAmount: 'unallocatedAmount',
};

const arReceiptTranslateCreate = (data) => headerTranslateCreate(data, AR_RECEIPT_HEADER, ['clientId', 'bankAccountId']);
const arReceiptTranslateUpdate = genericTranslateUpdate(AR_RECEIPT_HEADER, ['clientId', 'bankAccountId']);

const AR_RECEIPT_ALLOC_HEADER = {
  receipt: 'receiptId',
  invoice: 'invoiceId',
  amountAllocated: 'amountAllocated',
};

const arReceiptAllocationTranslateCreate = (data) =>
  headerTranslateCreate(data, AR_RECEIPT_ALLOC_HEADER, ['receiptId', 'invoiceId']);
const arReceiptAllocationTranslateUpdate = genericTranslateUpdate(AR_RECEIPT_ALLOC_HEADER, ['receiptId', 'invoiceId']);

// ── Translate: RecurringInvoice / Run ────────────────────────────────────────

const RECURRING_INVOICE_HEADER = {
  referenceNo: 'referenceNo',
  client: 'clientId',
  status: 'status',
  schedule: 'schedule',
  startDate: 'startDate',
  endDate: 'endDate',
  nextRunDate: 'nextRunDate',
  autoConfirm: 'autoConfirm',
  currencyCode: 'currencyCode',
  notes: 'notes',
};

function recurringInvoiceTranslateCreate(data) {
  return genericTranslateCreate(data, RECURRING_INVOICE_HEADER, (line, idx, companyId) =>
    defaultLineCreate(line, idx, companyId, {
      description: line.description ?? null,
      qty: line.qty ?? line.quantity ?? 0,
      unitPrice: line.unitPrice ?? 0,
      discountPct: line.discountPct ?? line.discount ?? 0,
      taxRate: line.taxRate ?? 0,
      warehouseId: line.warehouse ? toIdString(line.warehouse) : null,
    }));
}

const recurringInvoiceTranslateUpdate = genericTranslateUpdate(RECURRING_INVOICE_HEADER, ['clientId']);

const RECURRING_INVOICE_RUN_HEADER = {
  template: 'recurringInvoiceId',
  recurringInvoice: 'recurringInvoiceId',
  runDate: 'runDate',
  invoice: 'invoiceId',
  status: 'status',
  errorMessage: 'errorMessage',
};

const recurringInvoiceRunTranslateCreate = (data) => {
  const { createdById, ...payload } = headerTranslateCreate(
    data,
    RECURRING_INVOICE_RUN_HEADER,
    ['recurringInvoiceId', 'invoiceId'],
  );
  return payload;
};
const recurringInvoiceRunTranslateUpdate = genericTranslateUpdate(
  RECURRING_INVOICE_RUN_HEADER,
  ['recurringInvoiceId', 'invoiceId'],
);

// ── Translate: PurchaseOrder / Purchase / GRN / Return ───────────────────────

const PURCHASE_ORDER_HEADER = {
  referenceNo: 'referenceNo',
  supplier: 'supplierId',
  warehouse: 'warehouseId',
  status: 'status',
  orderDate: 'orderDate',
  expectedDeliveryDate: 'expectedDeliveryDate',
  currencyCode: 'currencyCode',
  exchangeRate: 'exchangeRate',
  subtotal: 'subtotal',
  taxAmount: 'taxAmount',
  totalAmount: 'totalAmount',
  notes: 'notes',
};

function purchaseOrderTranslateCreate(data) {
  const lines = Array.isArray(data.lines || data.items) ? (data.lines || data.items) : [];
  const linesSubtotal = lines.reduce((s, l) => {
    const qty = Number(l.qtyOrdered ?? l.qty ?? 0) || 0;
    const unitCost = Number(l.unitCost ?? 0) || 0;
    return s + qty * unitCost;
  }, 0);
  const linesTax = lines.reduce((s, l) => s + (Number(l.taxAmount) || 0), 0);
  const linesTotal = lines.reduce((s, l) => s + (Number(l.lineTotal) || 0), 0)
    || (linesSubtotal + linesTax);

  const subtotal = Number(data.subtotal) > 0 ? Number(data.subtotal) : linesSubtotal;
  const taxAmount = Number(data.taxAmount) > 0 ? Number(data.taxAmount) : linesTax;
  const totalAmount = Number(data.totalAmount) > 0 ? Number(data.totalAmount) : linesTotal;

  const payload = {
    ...data,
    subtotal: moneyStr(subtotal),
    taxAmount: moneyStr(taxAmount),
    totalAmount: moneyStr(totalAmount),
    balance: data.balance != null ? moneyStr(data.balance) : moneyStr(totalAmount),
  };

  return genericTranslateCreate(payload, {
    ...PURCHASE_ORDER_HEADER,
    balance: 'balance',
    amountPaid: 'amountPaid',
    paymentStatus: 'paymentStatus',
    freight: 'freight',
    source: 'source',
  }, (line, idx, companyId) => {
    const qty = Number(line.qtyOrdered ?? line.qty ?? 0) || 0;
    const unitCost = Number(line.unitCost ?? 0) || 0;
    const taxRate = Number(line.taxRate ?? 0) || 0;
    const lineSubtotal = qty * unitCost;
    const taxAmountLine = Number(line.taxAmount) > 0
      ? Number(line.taxAmount)
      : lineSubtotal * (taxRate / 100);
    const lineTotal = Number(line.lineTotal) > 0
      ? Number(line.lineTotal)
      : lineSubtotal + taxAmountLine;
    const budgetRefs = {};
    if (line.budgetId || line.budget_line_id) {
      budgetRefs.budgetId = toIdString(line.budgetId || line.budget_line_id);
    }
    if (line.accountId || line.account_id) {
      budgetRefs.accountId = toIdString(line.accountId || line.account_id);
    }
    return defaultLineCreate(line, idx, companyId, {
      qtyOrdered: qty,
      qtyReceived: line.qtyReceived ?? 0,
      unitCost,
      taxRate,
      taxAmount: taxAmountLine,
      lineTotal,
      ...(Object.keys(budgetRefs).length ? { budgetRefs } : {}),
    });
  });
}

const purchaseOrderTranslateUpdate = genericTranslateUpdate(
  PURCHASE_ORDER_HEADER,
  ['supplierId', 'warehouseId'],
);

const PURCHASE_HEADER = {
  purchaseNumber: 'purchaseNumber',
  supplier: 'supplierId',
  supplierInvoiceNumber: 'supplierInvoiceNumber',
  warehouse: 'warehouseId',
  status: 'status',
  currency: 'currency',
  subtotal: 'subtotal',
  taxAmount: 'taxAmount',
  totalAmount: 'totalAmount',
  purchaseDate: 'purchaseDate',
};

function purchaseTranslateCreate(data) {
  const lines = Array.isArray(data.lines || data.items) ? (data.lines || data.items) : [];
  const mappedLines = lines.map((line) => {
    const qty = Number(line.qty ?? line.quantity ?? 0) || 0;
    const unitCost = Number(line.unitCost ?? 0) || 0;
    const discount = Number(line.discount ?? 0) || 0;
    const taxRate = Number(line.taxRate ?? 0) || 0;
    const net = qty * unitCost - discount;
    const taxAmount = Number(line.taxAmount) >= 0 && line.taxAmount != null
      ? Number(line.taxAmount)
      : net * (taxRate / 100);
    const lineTotal = Number(line.lineTotal ?? line.totalWithTax) > 0
      ? Number(line.lineTotal ?? line.totalWithTax)
      : net + taxAmount;
    return { ...line, qty, quantity: qty, unitCost, taxRate, taxAmount, lineTotal, totalWithTax: lineTotal };
  });

  let subtotal = Number(data.subtotal);
  let taxAmount = Number(data.taxAmount ?? data.totalTax);
  let totalAmount = Number(data.totalAmount ?? data.roundedAmount ?? data.grandTotal);
  if (!Number.isFinite(subtotal) || subtotal <= 0) {
    subtotal = mappedLines.reduce((s, l) => s + (Number(l.qty) * Number(l.unitCost) - Number(l.discount || 0)), 0);
  }
  if (!Number.isFinite(taxAmount) || taxAmount < 0) {
    taxAmount = mappedLines.reduce((s, l) => s + Number(l.taxAmount || 0), 0);
  }
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    totalAmount = mappedLines.reduce((s, l) => s + Number(l.lineTotal || 0), 0) || (subtotal + taxAmount);
  }

  return genericTranslateCreate(
    { ...data, items: mappedLines, lines: mappedLines, subtotal, taxAmount, totalAmount },
    PURCHASE_HEADER,
    (line, idx, companyId) =>
      defaultLineCreate(line, idx, companyId, {
        qty: line.qty ?? line.quantity ?? 0,
        unitCost: line.unitCost ?? 0,
        taxRate: line.taxRate ?? 0,
        lineTotal: line.lineTotal ?? line.totalWithTax ?? 0,
      }),
  );
}

const purchaseTranslateUpdate = genericTranslateUpdate(PURCHASE_HEADER, ['supplierId', 'warehouseId']);

const GRN_HEADER = {
  referenceNo: 'referenceNo',
  purchaseOrder: 'purchaseOrderId',
  warehouse: 'warehouseId',
  supplier: 'supplierId',
  status: 'status',
  receivedDate: 'receivedDate',
  supplierInvoiceNo: 'supplierInvoiceNo',
  totalAmount: 'totalAmount',
  balance: 'balance',
  amountPaid: 'amountPaid',
  paymentStatus: 'paymentStatus',
  paymentDueDate: 'paymentDueDate',
};

function grnTranslateCreate(data) {
  return genericTranslateCreate(data, GRN_HEADER, (line, idx, companyId) =>
    defaultLineCreate(line, idx, companyId, {
      purchaseOrderLineId: line.purchaseOrderLine ? toIdString(line.purchaseOrderLine) : null,
      qtyReceived: line.qtyReceived ?? line.qty ?? 0,
      unitCost: line.unitCost ?? 0,
      taxRate: line.taxRate ?? 0,
      batchNo: line.batchNo ?? null,
    }));
}

const grnTranslateUpdate = genericTranslateUpdate(
  GRN_HEADER,
  ['purchaseOrderId', 'warehouseId', 'supplierId'],
);

const PURCHASE_RETURN_HEADER = {
  referenceNo: 'referenceNo',
  grn: 'grnId',
  supplier: 'supplierId',
  warehouse: 'warehouseId',
  status: 'status',
  returnDate: 'returnDate',
  reason: 'reason',
  totalAmount: 'totalAmount',
  refundMethod: 'refundMethod',
  bankAccountId: 'bankAccountId',
};

function purchaseReturnTranslateCreate(data) {
  return genericTranslateCreate(data, PURCHASE_RETURN_HEADER, (line, idx, companyId) =>
    defaultLineCreate(line, idx, companyId, {
      grnLineId: line.grnLine ? toIdString(line.grnLine) : null,
      qtyReturned: line.qtyReturned ?? line.qty ?? 0,
      unitCost: line.unitCost ?? 0,
    }));
}

const purchaseReturnTranslateUpdate = genericTranslateUpdate(
  PURCHASE_RETURN_HEADER,
  ['grnId', 'supplierId', 'warehouseId', 'bankAccountId'],
);

// ── Translate: APPayment / Allocation / FreightBill ────────────────────────

const AP_PAYMENT_HEADER = {
  referenceNo: 'referenceNo',
  supplier: 'supplierId',
  status: 'status',
  paymentDate: 'paymentDate',
  paymentMethod: 'paymentMethod',
  bankAccount: 'bankAccountId',
  amountPaid: 'amountPaid',
  currencyCode: 'currencyCode',
  exchangeRate: 'exchangeRate',
  unallocatedAmount: 'unallocatedAmount',
};

const apPaymentTranslateCreate = (data) => headerTranslateCreate(data, AP_PAYMENT_HEADER, ['supplierId', 'bankAccountId']);
const apPaymentTranslateUpdate = genericTranslateUpdate(AP_PAYMENT_HEADER, ['supplierId', 'bankAccountId']);

const AP_PAYMENT_ALLOC_HEADER = {
  payment: 'paymentId',
  grn: 'grnId',
  amountAllocated: 'amountAllocated',
};

const apPaymentAllocationTranslateCreate = (data) =>
  headerTranslateCreate(data, AP_PAYMENT_ALLOC_HEADER, ['paymentId', 'grnId']);
const apPaymentAllocationTranslateUpdate = genericTranslateUpdate(AP_PAYMENT_ALLOC_HEADER, ['paymentId', 'grnId']);

const FREIGHT_BILL_HEADER = {
  referenceNo: 'referenceNo',
  supplier: 'supplierId',
  carrierName: 'carrierName',
  amount: 'amount',
  account: 'account',
  invoiceDate: 'invoiceDate',
  paymentMethod: 'paymentMethod',
  status: 'status',
  grnMatches: 'grnMatches',
};

const freightBillTranslateCreate = (data) => headerTranslateCreate(data, FREIGHT_BILL_HEADER, ['supplierId']);
const freightBillTranslateUpdate = genericTranslateUpdate(FREIGHT_BILL_HEADER, ['supplierId']);

module.exports = {
  quotationToApi,
  quotationLineToApi,
  quotationTranslateCreate: withReferenceNo('QUOT', quotationTranslateCreate, { model: 'quotation' }),
  quotationTranslateUpdate,
  salesOrderToApi,
  salesOrderLineToApi,
  salesOrderTranslateCreate: withReferenceNo('SO', salesOrderTranslateCreate, { model: 'salesOrder' }),
  salesOrderTranslateUpdate,
  invoiceToApi,
  invoiceLineToApi,
  invoiceTranslateCreate: withReferenceNo('INV', invoiceTranslateCreate, { model: 'invoice' }),
  invoiceTranslateUpdate,
  creditNoteToApi,
  creditNoteTranslateCreate: withReferenceNo('CN', creditNoteTranslateCreate, { model: 'creditNote' }),
  creditNoteTranslateUpdate,
  deliveryNoteToApi,
  deliveryNoteTranslateCreate: withReferenceNo('DN', deliveryNoteTranslateCreate, { model: 'deliveryNote' }),
  deliveryNoteTranslateUpdate,
  pickPackToApi,
  pickPackLineToApi,
  pickPackTranslateCreate: withReferenceNo('PK', pickPackTranslateCreate, { model: 'pickPack' }),
  pickPackTranslateUpdate,
  arReceiptToApi,
  arReceiptTranslateCreate: withReferenceNo('RCP', arReceiptTranslateCreate, { model: 'aRReceipt' }),
  arReceiptTranslateUpdate,
  arReceiptAllocationToApi,
  arReceiptAllocationTranslateCreate,
  arReceiptAllocationTranslateUpdate,
  recurringInvoiceToApi,
  recurringInvoiceLineToApi,
  // REC-NNNNN — the only document numbered without a year segment.
  recurringInvoiceTranslateCreate: withReferenceNo('REC', recurringInvoiceTranslateCreate, {
    yearScoped: false,
    model: 'recurringInvoice',
  }),
  recurringInvoiceTranslateUpdate,
  recurringInvoiceRunToApi,
  recurringInvoiceRunTranslateCreate,
  recurringInvoiceRunTranslateUpdate,
  purchaseOrderToApi,
  purchaseOrderLineToApi,
  purchaseOrderTranslateCreate: withReferenceNo('PO', purchaseOrderTranslateCreate, { model: 'purchaseOrder' }),
  purchaseOrderTranslateUpdate,
  purchaseToApi,
  purchaseTranslateCreate: withReferenceNo('PO', purchaseTranslateCreate, {
    field: 'purchaseNumber',
    model: 'purchase',
  }),
  purchaseTranslateUpdate,
  grnToApi,
  grnLineToApi,
  grnTranslateCreate: withReferenceNo('GRN', grnTranslateCreate, { model: 'goodsReceivedNote' }),
  grnTranslateUpdate,
  purchaseReturnToApi,
  purchaseReturnLineToApi,
  purchaseReturnTranslateCreate: withReferenceNo('PRN', purchaseReturnTranslateCreate, { model: 'purchaseReturn' }),
  purchaseReturnTranslateUpdate,
  apPaymentToApi,
  apPaymentTranslateCreate: withReferenceNo('PAY', apPaymentTranslateCreate, { model: 'aPPayment' }),
  apPaymentTranslateUpdate,
  apPaymentAllocationToApi,
  apPaymentAllocationTranslateCreate,
  apPaymentAllocationTranslateUpdate,
  freightBillToApi,
  freightBillTranslateCreate: withReferenceNo('FB', freightBillTranslateCreate, { model: 'freightBill' }),
  freightBillTranslateUpdate,
  genericTranslateCreate,
  genericTranslateUpdate,
  mapLines,
};
