/**
 * ETL: Sync Phase 5 (Sales/AR) + Phase 6 (Purchases/AP) MongoDB → PostgreSQL.
 */
require('dotenv').config();

const mongoose = require('mongoose');
const { prisma, connectPrisma, disconnectPrisma } = require('../../lib/prisma');
const { generateObjectId } = require('../../utils/objectId');

const DRY_RUN = process.argv.includes('--dry-run');

function rawModel(name, collection) {
  const modelName = `EtlPhase56${name}`;
  if (mongoose.models[modelName]) return mongoose.models[modelName];
  return mongoose.model(modelName, new mongoose.Schema({}, { strict: false, collection }));
}

function oid(v) { return v == null ? null : String(v); }
function dec(v, fb = 0) {
  if (v == null) return fb;
  if (typeof v === 'object' && v.$numberDecimal) return v.$numberDecimal;
  if (typeof v === 'object' && v.toString) return v.toString();
  return v;
}

async function companyExists(id) {
  if (!id) return false;
  return Boolean(await prisma.company.findUnique({ where: { id }, select: { id: true } }));
}
async function refExists(model, id) {
  if (!id) return false;
  return Boolean(await prisma[model].findUnique({ where: { id }, select: { id: true } }));
}

function mapLines(doc, companyId, mapper) {
  const lines = Array.isArray(doc.lines || doc.items) ? (doc.lines || doc.items) : [];
  return lines.map((line, idx) => mapper(line, idx, companyId));
}

async function syncInvoices() {
  const M = rawModel('Invoice', 'invoices');
  const docs = await M.find({}).lean();
  console.log(`Invoices: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const clientId = oid(doc.client);
    if (!(await companyExists(companyId)) || !(await refExists('client', clientId))) continue;
    const lines = doc.lines || doc.items || [];
    await prisma.invoice.upsert({
      where: { id },
      create: {
        id,
        companyId,
        referenceNo: doc.referenceNo || doc.invoiceNumber || id,
        clientId,
        status: doc.status || 'draft',
        currencyCode: doc.currencyCode || doc.currency || 'RWF',
        exchangeRate: dec(doc.exchangeRate, 1),
        subtotal: dec(doc.subtotal, 0),
        taxAmount: dec(doc.taxAmount ?? doc.totalTax, 0),
        totalAmount: dec(doc.totalAmount ?? doc.grandTotal, 0),
        amountPaid: dec(doc.amountPaid, 0),
        amountOutstanding: dec(doc.amountOutstanding ?? doc.balance, 0),
        invoiceDate: doc.invoiceDate || doc.date || new Date(),
        dueDate: doc.dueDate || new Date(),
        quotationId: oid(doc.quotation),
        salesOrderId: oid(doc.salesOrder),
        deliveryNoteId: oid(doc.deliveryNote),
        revenueJournalEntryId: oid(doc.revenueJournalEntry),
        cogsJournalEntryId: oid(doc.cogsJournalEntry),
        payments: doc.payments || [],
        ebm: doc.ebm || {},
        notes: doc.notes || null,
        createdById: oid(doc.createdBy),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        status: doc.status || 'draft',
        amountPaid: dec(doc.amountPaid, 0),
        amountOutstanding: dec(doc.amountOutstanding ?? doc.balance, 0),
      },
    });
    await prisma.invoiceLine.deleteMany({ where: { invoiceId: id } });
    const lineRows = [];
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const productId = oid(line.product);
      if (!productId || !(await refExists('product', productId))) continue;
      lineRows.push({
        id: oid(line.lineId || line._id) || generateObjectId(),
        companyId,
        invoiceId: id,
        lineOrder: idx,
        lineId: oid(line.lineId || line._id),
        productId,
        productName: line.productName || null,
        productCode: line.productCode || line.itemCode || null,
        qty: dec(line.qty ?? line.quantity, 0),
        unitPrice: dec(line.unitPrice, 0),
        discountPct: dec(line.discountPct ?? line.discount, 0),
        taxRate: dec(line.taxRate, 0),
        taxCode: line.taxCode || 'A',
        lineSubtotal: dec(line.lineSubtotal ?? line.subtotal, 0),
        lineTax: dec(line.lineTax ?? line.taxAmount, 0),
        lineTotal: dec(line.lineTotal ?? line.totalWithTax, 0),
        unitCost: dec(line.unitCost, 0),
        cogsAmount: dec(line.cogsAmount, 0),
        warehouseId: oid(line.warehouse),
        qtyCredited: dec(line.qtyCredited, 0),
      });
    }
    if (lineRows.length) await prisma.invoiceLine.createMany({ data: lineRows });
    n += 1;
  }
  return n;
}

async function syncPurchaseOrders() {
  const M = rawModel('PurchaseOrder', 'purchaseorders');
  const docs = await M.find({}).lean();
  console.log(`PurchaseOrders: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const supplierId = oid(doc.supplier);
    if (!(await companyExists(companyId)) || !(await refExists('supplier', supplierId))) continue;
    await prisma.purchaseOrder.upsert({
      where: { id },
      create: {
        id,
        companyId,
        referenceNo: doc.referenceNo || id,
        supplierId,
        warehouseId: oid(doc.warehouse),
        orderDate: doc.orderDate || new Date(),
        status: doc.status || 'draft',
        source: doc.source || 'MANUAL',
        currencyCode: doc.currencyCode || 'RWF',
        subtotal: dec(doc.subtotal, 0),
        taxAmount: dec(doc.taxAmount, 0),
        totalAmount: dec(doc.totalAmount, 0),
        payments: doc.payments || [],
        freight: doc.freight || {},
        ebm: doc.ebm || {},
        createdById: oid(doc.createdBy),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: { status: doc.status || 'draft' },
    });
    await prisma.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: id } });
    const lines = doc.lines || [];
    const lineRows = [];
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const productId = oid(line.product);
      if (!productId || !(await refExists('product', productId))) continue;
      lineRows.push({
        id: oid(line._id) || generateObjectId(),
        companyId,
        purchaseOrderId: id,
        lineOrder: idx,
        productId,
        qtyOrdered: dec(line.qtyOrdered, 0),
        qtyReceived: dec(line.qtyReceived, 0),
        unitCost: dec(line.unitCost, 0),
        taxRate: dec(line.taxRate, 0),
        taxAmount: dec(line.taxAmount, 0),
        lineTotal: dec(line.lineTotal, 0),
        budgetRefs: {
          budgetId: oid(line.budgetId),
          budget_line_id: oid(line.budget_line_id),
          accountId: oid(line.accountId),
          encumbrance_id: oid(line.encumbrance_id),
        },
      });
    }
    if (lineRows.length) await prisma.purchaseOrderLine.createMany({ data: lineRows });
    n += 1;
  }
  return n;
}

async function syncGrns() {
  const M = rawModel('GRN', 'goodsreceivednotes');
  const docs = await M.find({}).lean();
  console.log(`GRNs: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const poId = oid(doc.purchaseOrder);
    const supplierId = oid(doc.supplier);
    const warehouseId = oid(doc.warehouse);
    if (!(await companyExists(companyId))) continue;
    if (!(await refExists('purchaseOrder', poId))) continue;
    if (!(await refExists('supplier', supplierId))) continue;
    if (!(await refExists('warehouse', warehouseId))) continue;
    await prisma.goodsReceivedNote.upsert({
      where: { id },
      create: {
        id,
        companyId,
        referenceNo: doc.referenceNo || id,
        purchaseOrderId: poId,
        warehouseId,
        supplierId,
        receivedDate: doc.receivedDate || new Date(),
        status: doc.status || 'draft',
        supplierInvoiceNo: doc.supplierInvoiceNo || null,
        totalAmount: dec(doc.totalAmount, 0),
        balance: dec(doc.balance, 0),
        amountPaid: dec(doc.amountPaid, 0),
        paymentStatus: doc.paymentStatus || 'pending',
        paymentDueDate: doc.paymentDueDate || null,
        journalEntryId: oid(doc.journalEntry),
        freight: doc.freight || {},
        ebm: doc.ebm || {},
        createdById: oid(doc.createdBy),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: { status: doc.status || 'draft', balance: dec(doc.balance, 0) },
    });
    await prisma.grnLine.deleteMany({ where: { grnId: id } });
    const lines = doc.lines || [];
    const lineRows = [];
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const productId = oid(line.product);
      if (!productId || !(await refExists('product', productId))) continue;
      lineRows.push({
        id: oid(line._id) || generateObjectId(),
        companyId,
        grnId: id,
        lineOrder: idx,
        purchaseOrderLineId: oid(line.purchaseOrderLine),
        productId,
        qtyReceived: dec(line.qtyReceived, 0),
        unitCost: dec(line.unitCost, 0),
        taxRate: dec(line.taxRate, 0),
        batchNo: line.batchNo || null,
        serialNumbers: line.serialNumbers || [],
        extra: {
          manufactureDate: line.manufactureDate || null,
          expiryDate: line.expiryDate || null,
        },
      });
    }
    if (lineRows.length) await prisma.grnLine.createMany({ data: lineRows });
    n += 1;
  }
  return n;
}

async function syncArAllocations() {
  const M = rawModel('ARReceiptAllocation', 'arreceiptallocations');
  const docs = await M.find({}).lean();
  console.log(`ARReceiptAllocations: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const receiptId = oid(doc.receipt);
    const invoiceId = oid(doc.invoice);
    if (!(await companyExists(companyId))) continue;
    if (!(await refExists('aRReceipt', receiptId))) continue;
    if (!(await refExists('invoice', invoiceId))) continue;
    await prisma.aRReceiptAllocation.upsert({
      where: { receiptId_invoiceId: { receiptId, invoiceId } },
      create: {
        id,
        companyId,
        receiptId,
        invoiceId,
        amountAllocated: dec(doc.amountAllocated, 0),
        createdById: oid(doc.createdBy),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: { amountAllocated: dec(doc.amountAllocated, 0) },
    });
    n += 1;
  }
  return n;
}

async function syncQuotations() {
  const M = rawModel('Quotation', 'quotations');
  const docs = await M.find({}).lean();
  console.log(`Quotations: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const clientId = oid(doc.client);
    if (!(await companyExists(companyId)) || !(await refExists('client', clientId))) continue;
    await prisma.quotation.upsert({
      where: { id },
      create: {
        id,
        companyId,
        referenceNo: doc.referenceNo || id,
        clientId,
        quotationDate: doc.quotationDate || new Date(),
        expiryDate: doc.expiryDate || null,
        status: doc.status || 'draft',
        currencyCode: doc.currencyCode || 'RWF',
        baseCurrency: doc.baseCurrency || 'RWF',
        exchangeRate: dec(doc.exchangeRate, 1),
        subtotal: dec(doc.subtotal, 0),
        totalDiscount: dec(doc.totalDiscount, 0),
        taxAmount: dec(doc.taxAmount, 0),
        totalAmount: dec(doc.totalAmount, 0),
        subtotalBase: dec(doc.subtotalBase, 0),
        totalAmountBase: dec(doc.totalAmountBase, 0),
        terms: doc.terms || null,
        notes: doc.notes || null,
        customerAction: doc.customerAction || {},
        convertedToInvoiceId: oid(doc.convertedToInvoice),
        convertedToSalesOrderId: oid(doc.convertedToSalesOrder),
        conversionDate: doc.conversionDate || null,
        approvedById: oid(doc.approvedBy),
        approvedDate: doc.approvedDate || null,
        createdById: oid(doc.createdBy),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: { status: doc.status || 'draft' },
    });
    await prisma.quotationLine.deleteMany({ where: { quotationId: id } });
    const lines = doc.lines || [];
    const lineRows = [];
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const productId = oid(line.product);
      if (!productId || !(await refExists('product', productId))) continue;
      lineRows.push({
        id: oid(line.lineId || line._id) || generateObjectId(),
        companyId,
        quotationId: id,
        lineOrder: idx,
        lineId: oid(line.lineId || line._id),
        productId,
        productName: line.productName || null,
        productSku: line.productSku || line.sku || null,
        productUnit: line.productUnit || line.unit || null,
        description: line.description || null,
        qty: dec(line.qty ?? line.quantity, 0),
        unit: line.unit || null,
        unitPrice: dec(line.unitPrice, 0),
        discountPct: dec(line.discountPct ?? line.discount, 0),
        taxRate: dec(line.taxRate, 0),
        lineSubtotal: dec(line.lineSubtotal ?? line.subtotal, 0),
        lineDiscount: dec(line.lineDiscount, 0),
        lineTotal: dec(line.lineTotal, 0),
        lineTax: dec(line.lineTax ?? line.taxAmount, 0),
        extra: line.extra || {},
      });
    }
    if (lineRows.length) await prisma.quotationLine.createMany({ data: lineRows });
    n += 1;
  }
  return n;
}

async function syncSalesOrders() {
  const M = rawModel('SalesOrder', 'salesorders');
  const docs = await M.find({}).lean();
  console.log(`SalesOrders: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const clientId = oid(doc.client);
    if (!(await companyExists(companyId)) || !(await refExists('client', clientId))) continue;
    const quotationId = oid(doc.quotation);
    if (quotationId && !(await refExists('quotation', quotationId))) continue;
    await prisma.salesOrder.upsert({
      where: { id },
      create: {
        id,
        companyId,
        referenceNo: doc.referenceNo || id,
        clientId,
        quotationId: quotationId || null,
        orderDate: doc.orderDate || new Date(),
        expectedDate: doc.expectedDate || null,
        status: doc.status || 'draft',
        currencyCode: doc.currencyCode || 'RWF',
        exchangeRate: dec(doc.exchangeRate, 1),
        subtotal: dec(doc.subtotal, 0),
        taxAmount: dec(doc.taxAmount, 0),
        totalAmount: dec(doc.totalAmount, 0),
        fulfillmentStatus: doc.fulfillmentStatus || 'pending',
        fulfillmentPercent: dec(doc.fulfillmentPercent, 0),
        stockReserved: Boolean(doc.stockReserved),
        isBackorder: Boolean(doc.isBackorder),
        parentOrderId: oid(doc.parentOrder),
        deliveryNotes: doc.deliveryNotes || [],
        invoices: doc.invoices || [],
        pickPackId: oid(doc.pickPack),
        notes: doc.notes || null,
        createdById: oid(doc.createdBy),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: { status: doc.status || 'draft' },
    });
    await prisma.salesOrderLine.deleteMany({ where: { salesOrderId: id } });
    const lines = doc.lines || [];
    const lineRows = [];
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const productId = oid(line.product);
      if (!productId || !(await refExists('product', productId))) continue;
      lineRows.push({
        id: oid(line.lineId || line._id) || generateObjectId(),
        companyId,
        salesOrderId: id,
        lineOrder: idx,
        lineId: oid(line.lineId || line._id),
        productId,
        description: line.description || null,
        qty: dec(line.qty ?? line.quantity, 0),
        qtyReserved: dec(line.qtyReserved, 0),
        qtyPicked: dec(line.qtyPicked, 0),
        qtyDelivered: dec(line.qtyDelivered, 0),
        qtyInvoiced: dec(line.qtyInvoiced, 0),
        unit: line.unit || null,
        unitPrice: dec(line.unitPrice, 0),
        discountPct: dec(line.discountPct, 0),
        taxRate: dec(line.taxRate, 0),
        lineTotal: dec(line.lineTotal, 0),
        lineTax: dec(line.lineTax, 0),
        warehouseId: oid(line.warehouse),
        batchId: oid(line.batch),
        serialNumbers: line.serialNumbers || [],
        status: line.status || 'pending',
        traceability: line.traceability || {},
      });
    }
    if (lineRows.length) await prisma.salesOrderLine.createMany({ data: lineRows });
    n += 1;
  }
  return n;
}

async function syncCreditNotes() {
  const M = rawModel('CreditNote', 'creditnotes');
  const docs = await M.find({}).lean();
  console.log(`CreditNotes: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const invoiceId = oid(doc.invoice);
    const clientId = oid(doc.client);
    if (!(await companyExists(companyId))) continue;
    if (!(await refExists('invoice', invoiceId))) continue;
    if (!(await refExists('client', clientId))) continue;
    await prisma.creditNote.upsert({
      where: { id },
      create: {
        id,
        companyId,
        referenceNo: doc.referenceNo || id,
        invoiceId,
        clientId,
        creditDate: doc.creditDate || new Date(),
        reason: doc.reason || null,
        type: doc.type || 'return',
        status: doc.status || 'draft',
        currencyCode: doc.currencyCode || 'RWF',
        subtotal: dec(doc.subtotal, 0),
        taxAmount: dec(doc.taxAmount, 0),
        totalAmount: dec(doc.totalAmount, 0),
        revenueReversalEntryId: oid(doc.revenueReversalEntry),
        cogsReversalEntryId: oid(doc.cogsReversalEntry),
        stockReversed: Boolean(doc.stockReversed),
        payments: doc.payments || [],
        ebm: doc.ebm || {},
        createdById: oid(doc.createdBy),
        confirmedById: oid(doc.confirmedBy),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: { status: doc.status || 'draft' },
    });
    await prisma.creditNoteLine.deleteMany({ where: { creditNoteId: id } });
    const lines = doc.lines || [];
    const lineRows = [];
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const productId = oid(line.product);
      if (!productId || !(await refExists('product', productId))) continue;
      lineRows.push({
        id: oid(line._id) || generateObjectId(),
        companyId,
        creditNoteId: id,
        lineOrder: idx,
        invoiceLineId: oid(line.invoiceLine),
        productId,
        productName: line.productName || null,
        quantity: dec(line.quantity ?? line.qty, 0),
        originalQty: dec(line.originalQty, 0),
        unitPrice: dec(line.unitPrice, 0),
        unitCost: dec(line.unitCost, 0),
        taxRate: dec(line.taxRate, 0),
        lineTotal: dec(line.lineTotal, 0),
        returnToWarehouseId: oid(line.returnToWarehouse),
        batchId: oid(line.batch),
        serialNumbers: line.serialNumbers || [],
      });
    }
    if (lineRows.length) await prisma.creditNoteLine.createMany({ data: lineRows });
    n += 1;
  }
  return n;
}

async function syncDeliveryNotes() {
  const M = rawModel('DeliveryNote', 'deliverynotes');
  const docs = await M.find({}).lean();
  console.log(`DeliveryNotes: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const clientId = oid(doc.client);
    const warehouseId = oid(doc.warehouse);
    if (!(await companyExists(companyId))) continue;
    if (!(await refExists('client', clientId))) continue;
    if (!(await refExists('warehouse', warehouseId))) continue;
    await prisma.deliveryNote.upsert({
      where: { id },
      create: {
        id,
        companyId,
        referenceNo: doc.referenceNo || id,
        salesOrderId: oid(doc.salesOrder),
        pickPackId: oid(doc.pickPack),
        invoiceId: oid(doc.invoice),
        clientId,
        warehouseId,
        quotationId: oid(doc.quotation),
        sourceType: doc.sourceType || null,
        deliveryDate: doc.deliveryDate || new Date(),
        status: doc.status || 'draft',
        stockDeducted: Boolean(doc.stockDeducted),
        notes: doc.notes || null,
        createdById: oid(doc.createdBy),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: { status: doc.status || 'draft' },
    });
    await prisma.deliveryNoteLine.deleteMany({ where: { deliveryNoteId: id } });
    const lines = doc.lines || [];
    const lineRows = [];
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const productId = oid(line.product);
      if (!productId || !(await refExists('product', productId))) continue;
      lineRows.push({
        id: oid(line._id) || generateObjectId(),
        companyId,
        deliveryNoteId: id,
        lineOrder: idx,
        invoiceLineId: oid(line.invoiceLine),
        productId,
        productName: line.productName || null,
        productCode: line.productCode || null,
        unit: line.unit || null,
        qtyToDeliver: dec(line.qtyToDeliver, 0),
        deliveredQty: dec(line.deliveredQty ?? line.qtyDelivered, 0),
        batchId: oid(line.batch),
        serialNumbers: line.serialNumbers || [],
        unitCost: dec(line.unitCost, 0),
        unitPrice: dec(line.unitPrice, 0),
        lineTotal: dec(line.lineTotal, 0),
        notes: line.notes || null,
      });
    }
    if (lineRows.length) await prisma.deliveryNoteLine.createMany({ data: lineRows });
    n += 1;
  }
  return n;
}

async function syncArReceipts() {
  const M = rawModel('ARReceipt', 'arreceipts');
  const docs = await M.find({}).lean();
  console.log(`ARReceipts: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const clientId = oid(doc.client);
    if (!(await companyExists(companyId)) || !(await refExists('client', clientId))) continue;
    await prisma.aRReceipt.upsert({
      where: { id },
      create: {
        id,
        companyId,
        referenceNo: doc.referenceNo || id,
        clientId,
        receiptDate: doc.receiptDate || new Date(),
        paymentMethod: doc.paymentMethod || 'cash',
        bankAccountId: oid(doc.bankAccount),
        amountReceived: dec(doc.amountReceived, 0),
        currencyCode: doc.currencyCode || 'RWF',
        exchangeRate: dec(doc.exchangeRate, 1),
        reference: doc.reference || null,
        status: doc.status || 'draft',
        journalEntryId: oid(doc.journalEntry),
        reverseJournalEntryId: oid(doc.reverseJournalEntry),
        unallocatedAmount: dec(doc.unallocatedAmount, 0),
        postedById: oid(doc.postedBy),
        postedAt: doc.postedAt || null,
        createdById: oid(doc.createdBy),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: { status: doc.status || 'draft', unallocatedAmount: dec(doc.unallocatedAmount, 0) },
    });
    n += 1;
  }
  return n;
}

async function syncPurchases() {
  const M = rawModel('Purchase', 'purchases');
  const docs = await M.find({}).lean();
  console.log(`Purchases: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const supplierId = oid(doc.supplier);
    if (!(await companyExists(companyId)) || !(await refExists('supplier', supplierId))) continue;
    await prisma.purchase.upsert({
      where: { id },
      create: {
        id,
        companyId,
        purchaseNumber: doc.purchaseNumber || doc.referenceNo || id,
        supplierId,
        supplierInvoiceNumber: doc.supplierInvoiceNumber || null,
        supplierInvoiceDate: doc.supplierInvoiceDate || null,
        warehouseId: oid(doc.warehouse),
        status: doc.status || 'draft',
        currency: doc.currency || doc.currencyCode || 'RWF',
        paymentTerms: doc.paymentTerms || null,
        subtotal: dec(doc.subtotal, 0),
        taxAmount: dec(doc.taxAmount, 0),
        totalAmount: dec(doc.totalAmount, 0),
        payments: doc.payments || [],
        purchaseDate: doc.purchaseDate || new Date(),
        stockAdded: Boolean(doc.stockAdded),
        ebm: doc.ebm || {},
        supplierSnapshot: doc.supplierSnapshot || {},
        createdById: oid(doc.createdBy),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: { status: doc.status || 'draft' },
    });
    await prisma.purchaseLine.deleteMany({ where: { purchaseId: id } });
    const lines = doc.lines || doc.items || [];
    const lineRows = [];
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const productId = oid(line.product);
      if (!productId || !(await refExists('product', productId))) continue;
      lineRows.push({
        id: oid(line._id) || generateObjectId(),
        companyId,
        purchaseId: id,
        lineOrder: idx,
        productId,
        qty: dec(line.qty ?? line.quantity, 0),
        unitCost: dec(line.unitCost, 0),
        taxRate: dec(line.taxRate, 0),
        lineTotal: dec(line.lineTotal, 0),
        extra: line.extra || {},
      });
    }
    if (lineRows.length) await prisma.purchaseLine.createMany({ data: lineRows });
    n += 1;
  }
  return n;
}

async function syncPurchaseReturns() {
  const M = rawModel('PurchaseReturn', 'purchasereturns');
  const docs = await M.find({}).lean();
  console.log(`PurchaseReturns: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const grnId = oid(doc.grn || doc.goodsReceivedNote);
    const supplierId = oid(doc.supplier);
    const warehouseId = oid(doc.warehouse);
    if (!(await companyExists(companyId))) continue;
    if (!(await refExists('goodsReceivedNote', grnId))) continue;
    if (!(await refExists('supplier', supplierId))) continue;
    if (!(await refExists('warehouse', warehouseId))) continue;
    await prisma.purchaseReturn.upsert({
      where: { id },
      create: {
        id,
        companyId,
        referenceNo: doc.referenceNo || id,
        grnId,
        supplierId,
        warehouseId,
        returnDate: doc.returnDate || new Date(),
        reason: doc.reason || null,
        status: doc.status || 'draft',
        totalAmount: dec(doc.totalAmount, 0),
        journalEntryId: oid(doc.journalEntry),
        refundMethod: doc.refundMethod || null,
        bankAccountId: oid(doc.bankAccount),
        refundJournalEntryId: oid(doc.refundJournalEntry),
        createdById: oid(doc.createdBy),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: { status: doc.status || 'draft' },
    });
    await prisma.purchaseReturnLine.deleteMany({ where: { purchaseReturnId: id } });
    const lines = doc.lines || [];
    const lineRows = [];
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const productId = oid(line.product);
      if (!productId || !(await refExists('product', productId))) continue;
      lineRows.push({
        id: oid(line._id) || generateObjectId(),
        companyId,
        purchaseReturnId: id,
        lineOrder: idx,
        grnLineId: oid(line.grnLine),
        productId,
        qtyReturned: dec(line.qtyReturned ?? line.qty, 0),
        unitCost: dec(line.unitCost, 0),
      });
    }
    if (lineRows.length) await prisma.purchaseReturnLine.createMany({ data: lineRows });
    n += 1;
  }
  return n;
}

async function syncApPayments() {
  const M = rawModel('APPayment', 'appayments');
  const docs = await M.find({}).lean();
  console.log(`APPayments: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const supplierId = oid(doc.supplier);
    if (!(await companyExists(companyId)) || !(await refExists('supplier', supplierId))) continue;
    await prisma.aPPayment.upsert({
      where: { id },
      create: {
        id,
        companyId,
        referenceNo: doc.referenceNo || id,
        supplierId,
        paymentDate: doc.paymentDate || new Date(),
        paymentMethod: doc.paymentMethod || 'cash',
        bankAccountId: oid(doc.bankAccount),
        amountPaid: dec(doc.amountPaid, 0),
        currencyCode: doc.currencyCode || 'RWF',
        exchangeRate: dec(doc.exchangeRate, 1),
        status: doc.status || 'draft',
        journalEntryId: oid(doc.journalEntry),
        reverseJournalEntryId: oid(doc.reverseJournalEntry),
        unallocatedAmount: dec(doc.unallocatedAmount, 0),
        createdById: oid(doc.createdBy),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: { status: doc.status || 'draft', unallocatedAmount: dec(doc.unallocatedAmount, 0) },
    });
    n += 1;
  }
  return n;
}

async function syncApAllocations() {
  const M = rawModel('APPaymentAllocation', 'appaymentallocations');
  const docs = await M.find({}).lean();
  console.log(`APPaymentAllocations: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const paymentId = oid(doc.payment);
    const grnId = oid(doc.grn || doc.goodsReceivedNote);
    if (!(await companyExists(companyId))) continue;
    if (!(await refExists('aPPayment', paymentId))) continue;
    if (!(await refExists('goodsReceivedNote', grnId))) continue;
    await prisma.aPPaymentAllocation.upsert({
      where: { paymentId_grnId: { paymentId, grnId } },
      create: {
        id,
        companyId,
        paymentId,
        grnId,
        amountAllocated: dec(doc.amountAllocated, 0),
        createdById: oid(doc.createdBy),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: { amountAllocated: dec(doc.amountAllocated, 0) },
    });
    n += 1;
  }
  return n;
}

async function syncFreightBills() {
  const M = rawModel('FreightBill', 'freightbills');
  const docs = await M.find({}).lean();
  console.log(`FreightBills: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    if (!(await companyExists(companyId))) continue;
    const supplierId = oid(doc.supplier);
    if (supplierId && !(await refExists('supplier', supplierId))) continue;
    await prisma.freightBill.upsert({
      where: { id },
      create: {
        id,
        companyId,
        referenceNo: doc.referenceNo || id,
        supplierId: supplierId || null,
        carrierName: doc.carrierName || null,
        amount: dec(doc.amount, 0),
        account: doc.account || null,
        invoiceDate: doc.invoiceDate || null,
        paymentMethod: doc.paymentMethod || null,
        status: doc.status || 'draft',
        grnMatches: doc.grnMatches || [],
        journalEntryId: oid(doc.journalEntry),
        createdById: oid(doc.createdBy),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: { status: doc.status || 'draft' },
    });
    n += 1;
  }
  return n;
}

async function syncRecurringInvoices() {
  const M = rawModel('RecurringInvoice', 'recurringinvoices');
  const docs = await M.find({}).lean();
  console.log(`RecurringInvoices: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const clientId = oid(doc.client);
    if (!(await companyExists(companyId)) || !(await refExists('client', clientId))) continue;
    await prisma.recurringInvoice.upsert({
      where: { id },
      create: {
        id,
        companyId,
        referenceNo: doc.referenceNo || id,
        clientId,
        schedule: doc.schedule || {},
        startDate: doc.startDate || new Date(),
        endDate: doc.endDate || null,
        nextRunDate: doc.nextRunDate || null,
        status: doc.status || 'active',
        autoConfirm: Boolean(doc.autoConfirm),
        currencyCode: doc.currencyCode || 'RWF',
        notes: doc.notes || null,
        lastRunAt: doc.lastRunAt || null,
        createdById: oid(doc.createdBy),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: { status: doc.status || 'active', nextRunDate: doc.nextRunDate || null },
    });
    await prisma.recurringInvoiceLine.deleteMany({ where: { recurringInvoiceId: id } });
    const lines = doc.lines || doc.items || [];
    const lineRows = [];
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const productId = oid(line.product);
      if (!productId || !(await refExists('product', productId))) continue;
      lineRows.push({
        id: oid(line._id) || generateObjectId(),
        companyId,
        recurringInvoiceId: id,
        lineOrder: idx,
        productId,
        description: line.description || null,
        qty: dec(line.qty ?? line.quantity, 0),
        unitPrice: dec(line.unitPrice, 0),
        discountPct: dec(line.discountPct, 0),
        taxRate: dec(line.taxRate, 0),
        warehouseId: oid(line.warehouse),
      });
    }
    if (lineRows.length) await prisma.recurringInvoiceLine.createMany({ data: lineRows });
    n += 1;
  }
  return n;
}

async function syncRecurringInvoiceRuns() {
  const M = rawModel('RecurringInvoiceRun', 'recurringinvoiceruns');
  const docs = await M.find({}).lean();
  console.log(`RecurringInvoiceRuns: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const recurringInvoiceId = oid(doc.recurringInvoice);
    if (!(await companyExists(companyId))) continue;
    if (!(await refExists('recurringInvoice', recurringInvoiceId))) continue;
    const invoiceId = oid(doc.invoice);
    if (invoiceId && !(await refExists('invoice', invoiceId))) continue;
    await prisma.recurringInvoiceRun.upsert({
      where: { recurringInvoiceId_runDate: { recurringInvoiceId, runDate: doc.runDate || new Date() } },
      create: {
        id,
        companyId,
        recurringInvoiceId,
        runDate: doc.runDate || new Date(),
        invoiceId: invoiceId || null,
        status: doc.status || 'success',
        errorMessage: doc.errorMessage || null,
        createdAt: doc.createdAt || new Date(),
      },
      update: { status: doc.status || 'success', invoiceId: invoiceId || null },
    });
    n += 1;
  }
  return n;
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI required');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  await connectPrisma();
  console.log(DRY_RUN ? 'DRY RUN' : 'SYNC');
  const results = {
    quotations: await syncQuotations(),
    salesOrders: await syncSalesOrders(),
    invoices: await syncInvoices(),
    creditNotes: await syncCreditNotes(),
    deliveryNotes: await syncDeliveryNotes(),
    arReceipts: await syncArReceipts(),
    arAllocations: await syncArAllocations(),
    recurringInvoices: await syncRecurringInvoices(),
    recurringInvoiceRuns: await syncRecurringInvoiceRuns(),
    purchaseOrders: await syncPurchaseOrders(),
    purchases: await syncPurchases(),
    grns: await syncGrns(),
    purchaseReturns: await syncPurchaseReturns(),
    apPayments: await syncApPayments(),
    apAllocations: await syncApAllocations(),
    freightBills: await syncFreightBills(),
  };
  console.log('Done:', results);
  await mongoose.disconnect();
  await disconnectPrisma();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  await disconnectPrisma().catch(() => {});
  process.exit(1);
});
