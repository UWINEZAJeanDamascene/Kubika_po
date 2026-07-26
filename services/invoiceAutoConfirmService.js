/**
 * Shared draft → confirmed invoice flow for recurring invoices and other automations.
 */

const Invoice = require('../models/Invoice');
const Product = require('../models/Product');
const Client = require('../models/Client');
const StockMovement = require('../models/StockMovement');
const JournalService = require('./journalService');
const TaxAutomationService = require('./taxAutomationService');
const warehouseService = require('./warehouseService');
const stockValidationService = require('./stockValidationService');
const cacheService = require('./cacheService');
const EBMSalesService = require('./ebmSalesService');
const { prisma } = require('../lib/prisma');
const { resolveCogsUnitCost } = require('../utils/productCost');
const { notifyPaymentReceived } = require('./notificationHelper');

function confirmError(code, message, statusCode = 409) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  throw err;
}

async function confirmDraftInvoice(companyId, invoiceId, userId, { submitEbm = true } = {}) {
  const invoice = await Invoice.findOne({ _id: invoiceId, company: companyId })
    .populate('lines.product client');

  if (!invoice) confirmError('ERR_INVOICE_NOT_FOUND', 'Invoice not found', 404);
  if (invoice.status !== 'draft') {
    confirmError('ERR_INVOICE_CONFIRMED', 'Invoice is not in draft status', 409);
  }
  if (!invoice.lines || invoice.lines.length === 0) {
    confirmError('ERR_EMPTY_INVOICE', 'Invoice must have at least one line item before confirming', 400);
  }

  const DeliveryNote = require('../models/DeliveryNote');
  const existingDeliveryNote = await DeliveryNote.findOne({
    invoice: invoice._id,
    status: 'confirmed',
  });
  if (existingDeliveryNote) {
    confirmError(
      'ERR_DELIVERY_EXISTS',
      'Cannot confirm invoice. A confirmed delivery note already exists for this invoice.',
      409,
    );
  }

  let totalInvoiceCOGS = 0;
  let hasStockableLines = false;

  for (const line of invoice.lines) {
    const product = await Product.findOne({ _id: line.product._id, company: companyId });
    if (!product) confirmError('ERR_PRODUCT_NOT_FOUND', `Product not found: ${line.product.name}`, 400);
    if (product.isActive === false) {
      confirmError('ERR_INACTIVE_PRODUCT', `Product ${product.name} is inactive`, 400);
    }

    const qty = line.qty || line.quantity || 0;
    if (qty <= 0) confirmError('ERR_INVALID_LINE_QTY', 'Line quantity must be greater than 0', 400);
    if ((line.unitPrice || 0) < 0) confirmError('ERR_INVALID_UNIT_PRICE', 'Unit price cannot be negative', 400);

    const isStockable = product.isStockable !== false;
    if (isStockable) {
      hasStockableLines = true;
      const unitCost = await resolveCogsUnitCost(product, companyId);
      if (unitCost === 0) {
        confirmError(
          'ERR_COST_LOOKUP_FAILED',
          `COGS cost lookup failed for product ${product.name}. A stockable product with zero cost is a data integrity problem.`,
          500,
        );
      }

      const cogsAmount = qty * unitCost;
      totalInvoiceCOGS += cogsAmount;
      line.unitCost = unitCost;
      line.cogsAmount = cogsAmount;

      const warehouseId = line.warehouse || product.defaultWarehouse;
      let availableQty = 0;
      if (warehouseId) {
        const stockLevel = await warehouseService.getStockLevel(companyId, product._id, warehouseId);
        availableQty = stockLevel.qty_available || 0;
      } else {
        availableQty = product.currentStock || 0;
      }

      if (availableQty < qty) {
        confirmError(
          'ERR_INSUFFICIENT_STOCK',
          `Insufficient stock for ${product.name}. Available: ${availableQty}, Required: ${qty}`,
          409,
        );
      }

      try {
        await stockValidationService.reserveForOrder(companyId, product._id, qty, warehouseId);
      } catch (reserveErr) {
        confirmError(
          'ERR_INSUFFICIENT_STOCK',
          reserveErr.message || `Failed to reserve stock for ${product.name}`,
          409,
        );
      }
    } else {
      line.unitCost = 0;
      line.cogsAmount = 0;
    }
  }

  for (const line of invoice.lines) {
    await prisma.invoiceLine.update({
      where: { id: String(line._id) },
      data: {
        unitCost: line.unitCost ?? 0,
        cogsAmount: line.cogsAmount ?? 0,
      },
    });
  }

  const taxLines = invoice.lines.map((line) => {
    const lineQty = line.qty || line.quantity || 0;
    const lineUnitPrice = line.unitPrice || 0;
    const lineDiscount = line.discount || 0;
    const lineNet = lineQty * lineUnitPrice - lineDiscount;
    return {
      netAmount: lineNet,
      taxRatePct: line.taxRate || 0,
      productId: line.product?._id || line.product,
    };
  });

  const salesTax = await TaxAutomationService.computeSalesTax(
    companyId,
    taxLines,
    invoice.invoiceDate,
  );

  try {
    const revenueEntry = await JournalService.createEntry(companyId, userId, {
      date: invoice.invoiceDate,
      description: `Invoice ${invoice.referenceNo || invoice.invoiceNumber} - Revenue Recognition`,
      sourceType: 'invoice',
      sourceId: invoice._id,
      sourceReference: invoice.referenceNo || invoice.invoiceNumber,
      lines: salesTax.journalLines,
      isAutoGenerated: true,
      sourceData: {
        vatAmount: salesTax.totals.tax,
        netAmount: salesTax.totals.net,
        grossAmount: salesTax.totals.gross,
        taxBreakdown: salesTax.lines,
      },
    });
    invoice.revenueJournalEntry = revenueEntry._id;
  } catch (journalError) {
    console.error('Error creating revenue journal entry:', journalError);
  }

  if (hasStockableLines && totalInvoiceCOGS > 0) {
    try {
      const cogsEntry = await JournalService.createCOGSEntry(companyId, userId, {
        invoiceId: invoice._id,
        invoiceNumber: invoice.referenceNo || invoice.invoiceNumber,
        clientName: invoice.client?.name || 'Unknown Client',
        date: invoice.invoiceDate,
        totalCost: totalInvoiceCOGS,
        lines: invoice.lines
          .filter((l) => l.cogsAmount > 0)
          .map((l) => ({
            productId: l.product._id,
            cogsAmount: l.cogsAmount,
          })),
      });
      invoice.cogsJournalEntry = cogsEntry._id;
    } catch (journalError) {
      console.error('Error creating COGS journal entry:', journalError);
    }
  }

  for (const line of invoice.lines) {
    const product = await Product.findOne({ _id: line.product._id, company: companyId });
    if (product && product.isStockable) {
      const qty = line.qty || line.quantity || 0;
      if (qty > 0) {
        const previousStock = product.currentStock || 0;
        const newStock = Math.max(0, previousStock - qty);
        await StockMovement.create({
          company: companyId,
          product: product._id,
          type: 'out',
          reason: 'sale',
          quantity: qty,
          previousStock,
          newStock,
          unitCost: line.unitCost || 0,
          totalCost: line.cogsAmount || 0,
          referenceType: 'invoice',
          referenceNumber: invoice.referenceNo || invoice.invoiceNumber,
          referenceDocument: invoice._id,
          referenceModel: 'Invoice',
          notes: `Invoice ${invoice.referenceNo || invoice.invoiceNumber} - Sale`,
          performedBy: userId,
          movementDate: new Date(),
        });
        product.currentStock = newStock;
        product.lastSaleDate = new Date();
        await product.save();
      }
    }
  }

  await Invoice.findByIdAndUpdate(invoice._id, {
    status: 'confirmed',
    stockDeducted: true,
    revenueJournalEntry: invoice.revenueJournalEntry,
    cogsJournalEntry: invoice.cogsJournalEntry,
  });

  const client = await Client.findOne({ _id: invoice.client, company: companyId });
  if (client) {
    client.outstandingBalance += invoice.roundedAmount || 0;
    await client.save();
  }

  if (invoice.quotation) {
    const Quotation = require('../models/Quotation');
    await Quotation.findByIdAndUpdate(invoice.quotation, {
      status: 'converted',
      convertedToInvoice: invoice._id,
      conversionDate: new Date(),
    });
  }

  try {
    await notifyPaymentReceived(companyId, invoice, 0);
  } catch (e) {
    console.error('notifyPaymentReceived failed', e);
  }

  try {
    await cacheService.bumpCompanyFinancialCaches(companyId);
  } catch (e) {
    console.error('Cache invalidation failed:', e);
  }

  if (submitEbm) {
    try {
      return await EBMSalesService.submitInvoice(invoice._id, { companyId });
    } catch (ebmError) {
      console.error('EBM sales submission failed after invoice confirmation:', ebmError.message);
      return ebmError.invoice || await Invoice.findOne({ _id: invoice._id, company: companyId })
        .populate('client lines.product createdBy');
    }
  }

  return Invoice.findOne({ _id: invoice._id, company: companyId })
    .populate('client lines.product createdBy');
}

module.exports = { confirmDraftInvoice };
