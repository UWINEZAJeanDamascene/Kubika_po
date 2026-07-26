// Module 7 - Error Codes
const mongoose = require("mongoose");
const DeliveryNote = require("../models/DeliveryNote");
const Quotation = require("../models/Quotation");
const Invoice = require("../models/Invoice");
const Product = require("../models/Product");
const StockMovement = require("../models/StockMovement");
const InventoryBatch = require("../models/InventoryBatch");
const StockBatch = require("../models/StockBatch");
const StockSerialNumber = require("../models/StockSerialNumber");
const Company = require("../models/Company");
const PDFDocument = require("pdfkit");
const JournalService = require("../services/journalService");
const { runInTransaction } = require("../services/transactionService");
const StockLevel = require("../models/StockLevel");
const emailService = require("../services/emailService");
const Client = require("../models/Client");

const ERR_DELIVERY_NOT_FOUND = "ERR_DELIVERY_NOT_FOUND";
const ERR_DELIVERY_CONFIRMED = "ERR_DELIVERY_CONFIRMED";
const ERR_DELIVERY_CANCELLED = "ERR_DELIVERY_CANCELLED";
const ERR_INVOICE_NOT_CONFIRMED = "ERR_INVOICE_NOT_CONFIRMED";
const ERR_INVOICE_CANCELLED = "ERR_INVOICE_CANCELLED";
const ERR_INSUFFICIENT_STOCK = "ERR_INSUFFICIENT_STOCK";
const ERR_BATCH_QUARANTINED = "ERR_BATCH_QUARANTINED";
const ERR_BATCH_NOT_FOUND = "ERR_BATCH_NOT_FOUND";
const ERR_SERIAL_NOT_IN_STOCK = "ERR_SERIAL_NOT_IN_STOCK";
const ERR_SERIAL_WRONG_WAREHOUSE = "ERR_SERIAL_WRONG_WAREHOUSE";
const ERR_EXCEEDS_INVOICE_QTY = "ERR_EXCEEDS_INVOICE_QTY";
const ERR_COST_LOOKUP_FAILED = "ERR_COST_LOOKUP_FAILED";

// Helper to convert MongoDB Decimal128 to number
const toNumber = (value) => {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && value.$numberDecimal) {
    return parseFloat(value.$numberDecimal);
  }
  if (typeof value === 'string') return parseFloat(value) || 0;
  return 0;
};
const ERR_COGS_ADJUSTMENT_FAILED = "ERR_COGS_ADJUSTMENT_FAILED";

// COGS adjustment tolerance (0.01 = 1 cent)
const COGS_TOLERANCE = 0.01;

const sendDeliveryNoteEmail = async (deliveryNote, companyId, action) => {
  try {
    const config = require('../src/config/environment').getConfig();
    if (!config.features?.emailNotifications || !config.email?.gmailUser) {
      return;
    }

    const invoice = await Invoice.findById(deliveryNote.invoice).populate('client');
    const client = invoice?.client;
    const clientEmail = client?.contact?.email || client?.email;
    if (!clientEmail) {
      console.warn('[DeliveryNote] No client email found');
      return;
    }

    const noteWithProducts = await DeliveryNote.findById(deliveryNote._id)
      .populate('lines.product', 'name')
      .populate('warehouse', 'name');

    const actionText = { confirmed: 'Completed', cancelled: 'Cancelled' }[action] || 'Updated';
    const subject = `Delivery Note ${deliveryNote.referenceNo} - ${actionText}`;

    const lines = noteWithProducts.lines || [];
    let itemsHtml = '';
    if (lines.length > 0) {
      itemsHtml = lines.map(line => `
        <tr>
          <td style="padding:10px; border-bottom:1px solid #ddd;">${line.product?.name || line.productName || 'Item'}</td>
          <td style="padding:10px; border-bottom:1px solid #ddd; text-align:center;">${line.qtyDelivered || line.quantity || 0}</td>
          <td style="padding:10px; border-bottom:1px solid #ddd; text-align:center;">${line.product?.unit || 'pcs'}</td>
        </tr>
      `).join('');
    }

    const html = `
      <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
        <div style="background:#10b981; padding:30px; border-radius:10px 10px 0 0;">
          <h1 style="color:white; margin:0; text-align:center;">📦 Delivery ${actionText}</h1>
        </div>
        <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
          <h2 style="color:#10b981; margin:0 0 5px;">${deliveryNote.referenceNo || ''}</h2>
          <p style="color:#666; margin:5px 0;">Date: ${new Date(deliveryNote.deliveryDate || deliveryNote.createdAt).toLocaleDateString()}</p>
          <p style="color:#666; margin:5px 0;">Status: <strong>${actionText}</strong></p>
          <div style="background:white; padding:15px; border-radius:8px; margin:20px 0;">
            <strong>Customer:</strong><br/>${client?.name || 'Customer'}
          </div>
          <div style="background:white; padding:15px; border-radius:8px; margin:20px 0;">
            <strong>Warehouse:</strong><br/>${noteWithProducts.warehouse?.name || 'N/A'}
          </div>
          <table style="width:100%; border-collapse:collapse; margin:20px 0;">
            <thead>
              <tr style="background:#10b981; color:white;">
                <th style="padding:12px; text-align:left;">Product</th>
                <th style="padding:12px; text-align:center;">Qty</th>
                <th style="padding:12px; text-align:center;">Unit</th>
              </tr>
            </thead>
            <tbody>${itemsHtml}</tbody>
          </table>
          <div style="text-align:center; margin-top:30px;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/delivery-notes/${deliveryNote._id}" style="background:#10b981; color:white; padding:12px 30px; text-decoration:none; border-radius:8px; display:inline-block;">View Delivery Note</a>
          </div>
          <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
          <p style="font-size:12px; color:#888; text-align:center;">KUBIKA SYSTEM — Manage Your Stock From Supply to Final Sale</p>
        </div>
      </div>`;

    await emailService.sendEmail(clientEmail, subject, html);
  } catch (err) {
    console.error('[DeliveryNote] Email failed:', err.message);
  }
};

/**
 * Enhance delivery note objects with computed fields expected by frontend
 * @param {Array|Object} deliveryNotes - Single delivery note or array
 * @returns {Array|Object} Enhanced delivery note(s)
 */
function enhanceDeliveryNotes(deliveryNotes) {
  if (!deliveryNotes) return deliveryNotes;

  const isArray = Array.isArray(deliveryNotes);
  const notes = isArray ? deliveryNotes : [deliveryNotes];

  for (const note of notes) {
    if (!note) continue;

    // Get lines array (use lines, fallback to items for legacy)
    const lines =
      note.lines && note.lines.length > 0 ? note.lines : note.items || [];

    // Sales value first (lineTotal / unitPrice), fall back to unitCost for COGS-only DNs
    let grandTotal = 0;
    if (Array.isArray(lines)) {
      for (const line of lines) {
        const qty = Number(
          line.qtyToDeliver !== undefined && line.qtyToDeliver !== null
            ? line.qtyToDeliver
            : (line.quantity ?? line.deliveredQty ?? 0),
        ) || 0;
        const lineTotal = Number(line.lineTotal);
        const unitPrice = Number(line.unitPrice) || 0;
        const unitCost = Number(line.unitCost) || 0;
        if (Number.isFinite(lineTotal) && lineTotal > 0) {
          grandTotal += lineTotal;
        } else if (unitPrice > 0) {
          grandTotal += qty * unitPrice;
        } else {
          grandTotal += qty * unitCost;
        }

        // Frontend detail table reads description / quantity
        if (!line.description) {
          line.description = line.productName
            || (line.product && typeof line.product === 'object' ? line.product.name : '')
            || '';
        }
        if (line.quantity === undefined || line.quantity === null) {
          line.quantity = qty;
        }
        if (!line.unit && line.product && typeof line.product === 'object') {
          line.unit = line.product.unit || 'pcs';
        }
      }
    }
    grandTotal = Math.round(grandTotal * 100) / 100;
    note.grandTotal = note.grandTotal || grandTotal;
    note.totalAmount = note.totalAmount || note.grandTotal;
    note.itemsCount = Array.isArray(lines) ? lines.length : 0;

    // Ensure legacy `items` shape is available for frontend (backwards compatibility)
    if (
      (!note.items || note.items.length === 0) &&
      Array.isArray(lines) &&
      lines.length > 0
    ) {
      try {
        note.items = lines.map((l) => ({
          _id: l._id,
          product: l.product || null,
          description: l.description || l.productName || "",
          quantity:
            l.qtyToDeliver !== undefined && l.qtyToDeliver !== null
              ? Number(l.qtyToDeliver)
              : l.orderedQty !== undefined && l.orderedQty !== null
                ? Number(l.orderedQty)
                : l.quantity !== undefined && l.quantity !== null
                  ? Number(l.quantity)
                  : l.deliveredQty !== undefined && l.deliveredQty !== null
                    ? Number(l.deliveredQty)
                    : 0,
          unit: l.unit || (l.product && l.product.unit) || "pcs",
          unitPrice: Number(l.unitPrice) || 0,
          lineTotal: Number(l.lineTotal) || 0,
        }));
      } catch (e) {
        // Non-fatal - leave items as-is if mapping fails
      }
    }

    // Tracking number alias (trackingNo -> trackingNumber)
    note.trackingNumber = note.trackingNumber || note.trackingNo || null;

    // Currency: invoice override, else company default RWF (not USD)
    if (note.invoice && note.invoice.currencyCode) {
      note.currencyCode = note.invoice.currencyCode;
    } else if (!note.currencyCode) {
      note.currencyCode = "RWF";
    }
  }

  return isArray ? notes : notes[0];
}

// @desc    Get all delivery notes (Module 7 filters)
// @route   GET /api/delivery-notes
// @access  Private
exports.getDeliveryNotes = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      page = 1,
      limit = 20,
      status,
      clientId,
      invoiceId,
      warehouseId,
      dateFrom,
      dateTo,
    } = req.query;

    const query = { company: companyId };

    if (status) {
      query.status = status;
    }

    if (clientId) {
      query.client = clientId;
    }

    // Module 7: Filter by invoice
    if (invoiceId) {
      query.invoice = invoiceId;
    }

    if (warehouseId) {
      query.warehouse = warehouseId;
    }

    if (dateFrom || dateTo) {
      query.deliveryDate = {};
      if (dateFrom) query.deliveryDate.$gte = new Date(dateFrom);
      if (dateTo) query.deliveryDate.$lte = new Date(dateTo);
    }

    const total = await DeliveryNote.countDocuments(query);
    let deliveryNotes = await DeliveryNote.find(query)
      .populate("client", "name code contact taxId")
      .populate("quotation", "referenceNo")
      .populate("salesOrder", "referenceNo quotation")
      .populate("invoice", "referenceNo status grandTotal currencyCode") // include referenceNo
      .populate("warehouse", "name code")
      .populate("lines.product", "name sku unit")
      .populate("items.product", "name sku unit") // Legacy
      .populate("createdBy", "name email")
      .populate("confirmedBy", "name email")
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    // Populate nested salesOrder.quotation
    await Promise.all(deliveryNotes.map(async (dn) => {
      if (dn.salesOrder?.quotation) {
        await dn.salesOrder.populate('quotation', 'referenceNo');
      }
    }));

    // Enhance with computed fields for frontend compatibility
    deliveryNotes = enhanceDeliveryNotes(deliveryNotes);

    res.json({
      success: true,
      count: deliveryNotes.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: deliveryNotes,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single delivery note (Module 7)
// @route   GET /api/delivery-notes/:id
// @access  Private
exports.getDeliveryNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    let deliveryNote = await DeliveryNote.findOne({
      _id: req.params.id,
      company: companyId,
    })
      .populate("client", "name code contact type taxId address")
      .populate("quotation", "referenceNo status items")
      .populate("salesOrder", "referenceNo quotation")
      .populate("invoice", "referenceNo status grandTotal currencyCode")
      .populate("warehouse", "name code")
      .populate("lines.product", "name sku unit trackingType")
      .populate("items.product", "name sku unit") // Legacy
      .populate("createdBy", "name email")
      .populate("confirmedBy", "name email")
      .populate("cancelledBy", "name email");

    // Populate nested salesOrder.quotation
    if (deliveryNote.salesOrder?.quotation) {
      await deliveryNote.salesOrder.populate('quotation', 'referenceNo');
    }

    // Enhance with computed fields for frontend compatibility
    deliveryNote = enhanceDeliveryNotes(deliveryNote);

    if (!deliveryNote) {
      return res.status(404).json({
        success: false,
        message: "Delivery note not found",
      });
    }

    res.json({
      success: true,
      data: deliveryNote,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new delivery note (Module 7 - requires invoice_id)
// @route   POST /api/delivery-notes
// @access  Private
exports.createDeliveryNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      invoice: invoiceId,
      lines,
      quotation: quotationId,
      carrier,
      trackingNo,
      deliveryDate,
      notes,
    } = req.body;

    // Module 7: Must have invoice_id
    if (!invoiceId) {
      return res.status(400).json({
        success: false,
        code: "ERR_INVOICE_REQUIRED",
        message: "invoice_id is required to create a delivery note",
      });
    }

    // Validate invoice exists and is confirmed
    const invoice = await Invoice.findOne({
      _id: invoiceId,
      company: companyId,
    });
    if (!invoice) {
      return res.status(404).json({
        success: false,
        code: ERR_DELIVERY_NOT_FOUND,
        message: "Invoice not found",
      });
    }

    // Get client from invoice
    const client = invoice.client;

    // Get warehouse - default from first invoice line or require explicitly
    let warehouse = req.body.warehouse;
    if (!warehouse && invoice.lines && invoice.lines.length > 0) {
      warehouse = invoice.lines[0].warehouse;
    }
    if (!warehouse) {
      return res.status(400).json({
        success: false,
        code: "ERR_WAREHOUSE_REQUIRED",
        message: "warehouse is required",
      });
    }

    // Build lines from invoice lines or provided lines
    let deliveryLines = [];
    if (lines && lines.length > 0) {
      // Use provided lines
      for (const line of lines) {
        const invoiceLine = invoice.lines.id(line.invoiceLineId);
        if (!invoiceLine) {
          return res.status(400).json({
            success: false,
            code: "ERR_INVALID_INVOICE_LINE",
            message: `Invoice line ${line.invoiceLineId} not found`,
          });
        }

        // Calculate remaining qty that can be delivered
        const alreadyDelivered = toNumber(invoiceLine.qtyDelivered);
        const invoiceQty = toNumber(invoiceLine.quantity);
        const remainingQty = invoiceQty - alreadyDelivered;
        const qtyToDeliver = line.qtyToDeliver || remainingQty;

        if (qtyToDeliver > remainingQty) {
          return res.status(422).json({
            success: false,
            code: ERR_EXCEEDS_INVOICE_QTY,
            message: `qty_to_deliver (${qtyToDeliver}) exceeds remaining invoice qty (${remainingQty})`,
          });
        }

        deliveryLines.push({
          invoiceLineId: line.invoiceLineId,
          product: invoiceLine.product,
          productName: invoiceLine.description || invoiceLine.productName,
          productCode: invoiceLine.itemCode || invoiceLine.productCode,
          unit: invoiceLine.unit,
          orderedQty: invoiceQty, // Original ordered qty
          qtyToDeliver: qtyToDeliver,
          deliveredQty: 0,
          pendingQty: qtyToDeliver,
          unitPrice: toNumber(invoiceLine.unitPrice),
          lineTotal: qtyToDeliver * toNumber(invoiceLine.unitPrice),
          unitCost:
            invoiceQty > 0
              ? (invoiceLine.cogsAmount && invoiceLine.cogsAmount.toString
                  ? Number(invoiceLine.cogsAmount.toString())
                  : Number(invoiceLine.cogsAmount || 0)) /
                invoiceQty
              : 0,
          batchId: line.batchId || null,
          serialNumbers: line.serialNumbers || [],
          notes: line.notes || "",
        });
      }
    } else {
      // Auto-create lines for all invoice lines with remaining qty
      for (const invoiceLine of invoice.lines) {
        const alreadyDelivered = toNumber(invoiceLine.qtyDelivered);
        const invoiceQty = toNumber(invoiceLine.quantity);
        const remainingQty = invoiceQty - alreadyDelivered;
        if (remainingQty > 0) {
          deliveryLines.push({
            invoiceLineId: invoiceLine._id,
            product: invoiceLine.product,
            productName: invoiceLine.description || invoiceLine.productName,
            productCode: invoiceLine.itemCode || invoiceLine.productCode,
            unit: invoiceLine.unit,
            orderedQty: invoiceQty,
            qtyToDeliver: remainingQty,
            deliveredQty: 0,
            pendingQty: remainingQty,
            unitPrice: toNumber(invoiceLine.unitPrice),
            lineTotal: remainingQty * toNumber(invoiceLine.unitPrice),
            unitCost:
              invoiceQty > 0
                ? (invoiceLine.cogsAmount && invoiceLine.cogsAmount.toString
                    ? Number(invoiceLine.cogsAmount.toString())
                    : Number(invoiceLine.cogsAmount || 0)) /
                  invoiceQty
                : 0,
            batchId: null,
            serialNumbers: [],
            notes: "",
          });
        }
      }
    }

    const deliveryNote = await DeliveryNote.create({
      company: companyId,
      invoice: invoiceId,
      quotation: quotationId,
      client,
      warehouse,
      carrier: carrier || null,
      trackingNo: trackingNo || null,
      deliveryDate: deliveryDate || new Date(),
      lines: deliveryLines,
      items: deliveryLines, // Legacy support
      notes: notes || "",
      status: "draft",
      createdBy: req.user.id,
    });

    await deliveryNote.populate(
      "client lines.product warehouse createdBy invoice",
    );

    res.status(201).json({
      success: true,
      data: deliveryNote,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update delivery note (Module 7 - draft only)
// @route   PUT /api/delivery-notes/:id
// @access  Private
exports.updateDeliveryNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    let deliveryNote = await DeliveryNote.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!deliveryNote) {
      return res.status(404).json({
        success: false,
        message: "Delivery note not found",
      });
    }

    // Only draft delivery notes can be updated
    if (deliveryNote.status !== "draft") {
      return res.status(409).json({
        success: false,
        code: ERR_DELIVERY_CONFIRMED,
        message: `Cannot update delivery note with status: ${deliveryNote.status}`,
      });
    }

    // Update allowed fields
    const allowedFields = [
      "carrier",
      "trackingNo",
      "deliveryDate",
      "notes",
      "deliveredBy",
      "vehicle",
      "deliveryAddress",
    ];

    // If lines are being updated, validate
    if (req.body.lines) {
      const invoice = await Invoice.findById(deliveryNote.invoice);
      if (!invoice) {
        return res.status(404).json({
          success: false,
          message: "Invoice not found",
        });
      }

      for (const line of req.body.lines) {
        const invoiceLine = invoice.lines.id(line.invoiceLineId);
        if (!invoiceLine) {
          return res.status(400).json({
            success: false,
            code: "ERR_INVALID_INVOICE_LINE",
            message: `Invoice line ${line.invoiceLineId} not found`,
          });
        }

        const alreadyDelivered = invoiceLine.qtyDelivered || 0;
        const remainingQty = invoiceLine.quantity - alreadyDelivered;
        if (line.qtyToDeliver > remainingQty) {
          return res.status(400).json({
            success: false,
            code: ERR_EXCEEDS_INVOICE_QTY,
            message: `qty_to_deliver exceeds remaining invoice qty`,
          });
        }
      }

      deliveryNote.lines = req.body.lines;
    }

    // Apply allowed fields
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        deliveryNote[field] = req.body[field];
      }
    }

    deliveryNote = await deliveryNote
      .save()
      .populate("client lines.product warehouse createdBy invoice");

    res.json({
      success: true,
      data: deliveryNote,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete delivery note (draft only)
// @route   DELETE /api/delivery-notes/:id
// @access  Private
exports.deleteDeliveryNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const deliveryNote = await DeliveryNote.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!deliveryNote) {
      return res.status(404).json({
        success: false,
        message: "Delivery note not found",
      });
    }

    // Only draft delivery notes can be deleted
    if (deliveryNote.status !== "draft") {
      return res.status(400).json({
        success: false,
        message: "Only draft delivery notes can be deleted",
      });
    }

    await deliveryNote.deleteOne();

    // If linked to quotation, revert quotation status
    if (deliveryNote.quotation) {
      await Quotation.findByIdAndUpdate(deliveryNote.quotation, {
        status: "approved",
      });
    }

    res.json({
      success: true,
      message: "Delivery note deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Confirm delivery note (Module 7 - stock consumption)
// @route   POST /api/delivery-notes/:id/confirm
// @access  Private
//
// Module 7: This replaces the old dispatch -> confirm flow.
// Now it's simply draft -> confirmed directly.
exports.confirmDelivery = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const deliveryNoteId = req.params.id;

    // Find delivery note with populated data
    let deliveryNote = await DeliveryNote.findOne({
      _id: deliveryNoteId,
      company: companyId,
    })
      .populate("lines.product")
      .populate("invoice")
      .populate("warehouse");

    if (!deliveryNote) {
      return res.status(404).json({
        success: false,
        code: ERR_DELIVERY_NOT_FOUND,
        message: "Delivery note not found",
      });
    }

    // Validate status is draft
    if (deliveryNote.status !== "draft") {
      return res.status(400).json({
        success: false,
        code: ERR_DELIVERY_CONFIRMED,
        message: `Cannot confirm delivery note with status: ${deliveryNote.status}`,
      });
    }

    // Get the invoice
    const invoice = await Invoice.findById(deliveryNote.invoice);
    if (!invoice) {
      return res.status(404).json({
        success: false,
        code: ERR_DELIVERY_NOT_FOUND,
        message: "Invoice not found",
      });
    }

    // Validate invoice is in a deliverable state (confirmed, partially_paid, or fully_paid)
    const deliverableStatuses = ["confirmed", "partially_paid", "fully_paid"];
    if (!deliverableStatuses.includes(invoice.status)) {
      return res.status(400).json({
        success: false,
        code: ERR_INVOICE_NOT_CONFIRMED,
        message: "Invoice must be confirmed or paid before confirming delivery",
      });
    }

    // ========== STEP 1: VALIDATION ==========
    for (const line of deliveryNote.lines) {
      const invoiceLine = invoice.lines.id(line.invoiceLineId);
      if (!invoiceLine) {
        return res.status(400).json({
          success: false,
          code: "ERR_INVALID_INVOICE_LINE",
          message: `Invoice line ${line.invoiceLineId} not found`,
        });
      }

      // Calculate remaining qty
      const alreadyDelivered = invoiceLine.qtyDelivered || 0;
      const remainingQty = invoiceLine.quantity - alreadyDelivered;

      // Validate qty_to_deliver doesn't exceed remaining
      if (line.qtyToDeliver > remainingQty) {
        return res.status(400).json({
          success: false,
          code: ERR_EXCEEDS_INVOICE_QTY,
          message: `qty_to_deliver (${line.qtyToDeliver}) exceeds remaining invoice qty (${remainingQty}) for ${line.productName}`,
        });
      }

      const product = line.product;
      if (!product) continue;

      const trackingType = product.trackingType || "none";

      // If product is stockable, ensure we can resolve a COGS unit cost (> 0)
      const isStockable = product.isStockable !== false;
      if (isStockable) {
        const invoiceLineForCost = invoice.lines.id(line.invoiceLineId);
        let estimatedUnitCost =
          invoiceLineForCost &&
          invoiceLineForCost.unitCost !== undefined &&
          invoiceLineForCost.unitCost !== null
            ? invoiceLineForCost.unitCost.toString
              ? Number(invoiceLineForCost.unitCost.toString())
              : Number(invoiceLineForCost.unitCost)
            : invoiceLineForCost && invoiceLineForCost.cogsAmount
              ? (invoiceLineForCost.cogsAmount.toString
                  ? Number(invoiceLineForCost.cogsAmount.toString())
                  : Number(invoiceLineForCost.cogsAmount)) /
                Number(invoiceLineForCost.quantity || 1)
              : 0;

        if (!estimatedUnitCost) {
          const { resolveCogsUnitCost } = require("../utils/productCost");
          estimatedUnitCost = await resolveCogsUnitCost(product, companyId);
        }

        if (!estimatedUnitCost) {
          return res.status(500).json({
            success: false,
            code: ERR_COST_LOOKUP_FAILED,
            message: `COGS cost lookup failed for product ${product.name}. A stockable product with zero cost is a data integrity problem.`,
          });
        }
      }

      // Batch validation
      if (trackingType === "batch") {
        if (!line.batchId) {
          return res.status(400).json({
            success: false,
            code: "ERR_BATCH_REQUIRED",
            message: `batch_id required for product ${product.name} (tracking_type=batch)`,
          });
        }

        const batch = await StockBatch.findOne({
          _id: line.batchId,
          company: companyId,
          product: product._id,
        });

        if (!batch) {
          return res.status(404).json({
            success: false,
            code: ERR_BATCH_NOT_FOUND,
            message: `Batch not found for product ${product.name}`,
          });
        }

        if (batch.isQuarantined === true) {
          return res.status(409).json({
            success: false,
            code: ERR_BATCH_QUARANTINED,
            message: `Batch ${batch.batchNo} is quarantined`,
          });
        }

        const availableQty = Number(batch.qtyOnHand) || 0;
        if (availableQty < line.qtyToDeliver) {
          return res.status(409).json({
            success: false,
            code: ERR_INSUFFICIENT_STOCK,
            message: `Insufficient stock in batch ${batch.batchNo}. Available: ${availableQty}, Requested: ${line.qtyToDeliver}`,
          });
        }
      }

      // Serial validation
      if (trackingType === "serial") {
        if (!line.serialNumbers || line.serialNumbers.length === 0) {
          return res.status(400).json({
            success: false,
            code: "ERR_SERIAL_REQUIRED",
            message: `serial_numbers required for product ${product.name} (tracking_type=serial)`,
          });
        }

        if (line.serialNumbers.length !== line.qtyToDeliver) {
          return res.status(400).json({
            success: false,
            code: "ERR_SERIAL_COUNT_MISMATCH",
            message: `Serial count must equal qty_to_deliver`,
          });
        }

        for (const serialId of line.serialNumbers) {
          const serial = await StockSerialNumber.findOne({
            _id: serialId,
            company: companyId,
            product: product._id,
          });

          if (!serial) {
            return res.status(404).json({
              success: false,
              code: "ERR_SERIAL_NOT_FOUND",
              message: `Serial number not found`,
            });
          }

          if (serial.status !== "in_stock") {
            return res.status(409).json({
              success: false,
              code: ERR_SERIAL_NOT_IN_STOCK,
              message: `Serial ${serial.serialNo} is ${serial.status}, not in_stock`,
            });
          }

          if (String(serial.warehouse) !== String(deliveryNote.warehouse._id)) {
            return res.status(400).json({
              success: false,
              code: ERR_SERIAL_WRONG_WAREHOUSE,
              message: `Serial ${serial.serialNo} is in different warehouse`,
            });
          }
        }
      }
    }

    // ========== STEPS 2-7: Execute in transaction ==========
    const inventoryService = require("../services/inventoryService");
    const cogsAdjustments = [];

    await runInTransaction(async (session) => {
      // Process each line
      for (const line of deliveryNote.lines) {
        if (line.qtyToDeliver <= 0) continue;

        const product = await Product.findOne({
          _id: line.product._id,
          company: companyId,
        }).session(session);
        if (!product) continue;

        const trackingType = product.trackingType || "none";
        let actualUnitCost = 0;
        let totalCost = 0;

        // ========== STEP 2: CONSUME STOCK (FIFO) ==========
        if (trackingType === "none" || trackingType === "fifo") {
          // FIFO consumption - consume lots in received_at ASC order
          const consumeResult = await inventoryService.consume(
            companyId,
            product._id,
            line.qtyToDeliver,
            { method: "fifo", warehouse: deliveryNote.warehouse._id, session },
          );
          actualUnitCost = consumeResult.averageCost
            ? consumeResult.averageCost.toString
              ? Number(consumeResult.averageCost.toString())
              : Number(consumeResult.averageCost)
            : 0;
          totalCost = consumeResult.totalCost
            ? consumeResult.totalCost.toString
              ? Number(consumeResult.totalCost.toString())
              : Number(consumeResult.totalCost)
            : 0;
        } else if (trackingType === "wac") {
          // WAC - use average cost from product
          actualUnitCost = product.averageCost
            ? product.averageCost.toString
              ? Number(product.averageCost.toString())
              : Number(product.averageCost)
            : 0;
          totalCost = actualUnitCost * Number(line.qtyToDeliver || 0);
        } else if (trackingType === "batch" && line.batchId) {
          // Batch-specific consumption
          const batch = await StockBatch.findById(line.batchId).session(
            session,
          );
          actualUnitCost = batch?.unitCost
            ? batch.unitCost.toString
              ? Number(batch.unitCost.toString())
              : Number(batch.unitCost)
            : 0;
          totalCost = actualUnitCost * Number(line.qtyToDeliver || 0);

          // Deduct from batch
          batch.qtyOnHand = (batch.qtyOnHand || 0) - line.qtyToDeliver;
          await batch.save({ session });
        }

        // ========== STEP 3: UPDATE STOCK LEVELS ==========
        // Note: Product.currentStock is already updated above
        // InventoryBatch quantities are managed by inventoryService.consume/reverseConsume

        // Update product quantity using direct update to avoid caching issues
        const previousStock = product.currentStock || 0;
        const newStock = Math.max(0, previousStock - line.qtyToDeliver);
        // Also release the reservation for the delivered qty so that
        // qty_available (currentStock - reservedQuantity) stays accurate.
        // Clamp at 0 so a stale/partial reservation never produces a negative value.
        const currentReserved = Number(product.reservedQuantity) || 0;
        const reservationToRelease = Math.min(
          Number(line.qtyToDeliver),
          currentReserved,
        );
        await Product.findByIdAndUpdate(
          product._id,
          {
            $set: { currentStock: newStock },
            $inc: { reservedQuantity: -reservationToRelease },
          },
          { session },
        );

        // ── Decrement StockLevel for this product/warehouse (dispatch) ────────
        try {
          await StockLevel.updateOne(
            {
              company_id: companyId,
              product_id: product._id,
              warehouse_id: deliveryNote.warehouse._id,
              qty_on_hand: { $gte: Number(line.qtyToDeliver) },
            },
            {
              $inc: { qty_on_hand: -Number(line.qtyToDeliver) },
              $set: {
                last_movement_at: new Date(),
                last_movement_type: "dispatch",
              },
            },
            { session },
          );
        } catch (slErr) {
          // StockLevel sync is best-effort — do not abort the delivery confirmation
          console.error(
            "StockLevel sync failed for delivery line:",
            slErr.message,
          );
        }

        // ========== STEP 4: CREATE STOCK MOVEMENT (dispatch) ==========
        await StockMovement.create(
          [
            {
              company: companyId,
              product: product._id,
              warehouse: deliveryNote.warehouse._id,
              type: "out",
              reason: "dispatch",
              quantity: line.qtyToDeliver,
              previousStock,
              newStock,
              unitCost: actualUnitCost,
              totalCost,
              sourceType: "delivery_note",
              sourceId: deliveryNote._id,
              referenceNumber: deliveryNote.referenceNo,
              notes: `DN#${deliveryNote.referenceNo} - ${line.productName}`,
              performedBy: req.user.id,
              movementDate: new Date(),
            },
          ],
          { session },
        );

        // ========== STEP 5: UPDATE SERIAL STATUS ==========
        if (
          trackingType === "serial" &&
          line.serialNumbers &&
          line.serialNumbers.length > 0
        ) {
          await StockSerialNumber.updateMany(
            { _id: { $in: line.serialNumbers } },
            {
              status: "dispatched",
              dispatchedVia: line._id,
              dispatchedAt: new Date(),
              warehouse: deliveryNote.warehouse._id,
            },
            { session },
          );
        }

        // Store actual cost on line for COGS adjustment
        line.unitCost = actualUnitCost;
        line.deliveredQty = line.qtyToDeliver;
        line.pendingQty = 0;

        // ========== STEP 6: COGS ADJUSTMENT ==========
        // Compare actual cost vs estimated cost from invoice line
        const invoiceLine = invoice.lines.id(line.invoiceLineId);
        if (invoiceLine && invoiceLine.quantity > 0) {
          // Prefer unitCost recorded on the invoice line (set at invoice confirmation),
          // fall back to cogsAmount/quantity when unitCost is not present.
          const estimatedUnitCost =
            invoiceLine.unitCost !== undefined && invoiceLine.unitCost !== null
              ? invoiceLine.unitCost.toString
                ? Number(invoiceLine.unitCost.toString())
                : Number(invoiceLine.unitCost)
              : invoiceLine.cogsAmount
                ? (invoiceLine.cogsAmount.toString
                    ? Number(invoiceLine.cogsAmount.toString())
                    : Number(invoiceLine.cogsAmount)) /
                  Number(invoiceLine.quantity || 1)
                : 0;

          const rawDiff =
            Number(totalCost || 0) -
            Number(estimatedUnitCost || 0) * Number(line.qtyToDeliver || 0);
          // Round to cents to avoid tiny floating point mismatches
          const costDifference = Math.round(rawDiff * 100) / 100;

          // Only post adjustment if difference > tolerance
          if (Math.abs(costDifference) > COGS_TOLERANCE) {
            cogsAdjustments.push({
              product: product,
              line: line,
              estimatedCost:
                Math.round(
                  Number(estimatedUnitCost || 0) *
                    Number(line.qtyToDeliver || 0) *
                    100,
                ) / 100,
              actualCost: Math.round(Number(totalCost || 0) * 100) / 100,
              difference: costDifference,
            });
          }
        }

        // ========== STEP 7: UPDATE INVOICE LINE ==========
        if (invoiceLine) {
          invoiceLine.qtyDelivered =
            (invoiceLine.qtyDelivered || 0) + line.qtyToDeliver;
        }
      }

      // Save invoice with updated qtyDelivered
      await invoice.save({ session });

      // Save delivery note lines
      deliveryNote.lines.forEach((line) => line.markModified("unitCost"));
      await deliveryNote.save({ session });

      // ========== POST COGS ADJUSTMENTS ==========
      if (cogsAdjustments.length > 0) {
        const { getAccount } = require("../constants/chartOfAccounts");
        const entries = [];

        for (const adj of cogsAdjustments) {
          const product = adj.product;
          const line = adj.line;
          const difference = adj.difference;
          const isIncrease = difference > 0;

          const cogsAccount = product.cogsAccount || product.cogs_account_id;
          const inventoryAccount =
            product.inventoryAccount || product.inventory_account_id;

          if (!cogsAccount || !inventoryAccount) {
            console.warn(
              "Missing COGS or Inventory account for product:",
              product._id,
            );
            continue;
          }

          const cogsAccountName =
            getAccount(cogsAccount)?.name || "Cost of Goods Sold";
          const inventoryAccountName =
            getAccount(inventoryAccount)?.name || "Inventory";

          const narration = `COGS Adjustment - ${line.productName} - DN#${deliveryNote.referenceNo} - cost variance`;

          const journalEntry = {
            date: new Date(),
            description: narration,
            sourceType: "cogs_adjustment",
            sourceId: deliveryNote._id,
            sourceReference: `DN-ADJ-${deliveryNote.referenceNo}`,
            lines: [
              {
                accountCode: isIncrease ? cogsAccount : inventoryAccount,
                accountName: isIncrease
                  ? cogsAccountName
                  : inventoryAccountName,
                debit: isIncrease ? Math.abs(difference) : 0,
                credit: isIncrease ? 0 : Math.abs(difference),
                description: narration,
              },
              {
                accountCode: isIncrease ? inventoryAccount : cogsAccount,
                accountName: isIncrease
                  ? inventoryAccountName
                  : cogsAccountName,
                debit: isIncrease ? 0 : Math.abs(difference),
                credit: isIncrease ? Math.abs(difference) : 0,
                description: narration,
              },
            ],
          };

          entries.push(journalEntry);
        }

        if (entries.length > 0) {
          try {
            if (typeof JournalService.createEntriesAtomic === "function") {
              await JournalService.createEntriesAtomic(
                companyId,
                req.user.id,
                entries,
                { session },
              );
            } else {
              // Fallback: create entries one by one but keep session
              for (const e of entries) {
                await JournalService.createEntry(companyId, req.user.id, {
                  ...e,
                  session,
                });
              }
            }
          } catch (err) {
            console.error("COGS adjustment failed (atomic post):", err);
          }
        }
      }

      // Update delivery note status
      deliveryNote.status = "confirmed";
      deliveryNote.confirmedBy = req.user.id;
      deliveryNote.confirmedDate = new Date();
      deliveryNote.stockDeducted = true;
      await deliveryNote.save({ session });
    });

    await deliveryNote.populate(
      "lines.product warehouse createdBy confirmedBy invoice",
    );

    try {
      const cacheService = require("../services/cacheService");
      await cacheService.bumpCompanyFinancialCaches(companyId);
    } catch (e) {
      console.error("Cache bump after delivery confirm failed:", e);
    }

    // Send email notification for delivery completed
    if (req.body.sendEmail) {
      await sendDeliveryNoteEmail(deliveryNote, companyId, 'confirmed');
    }

    res.json({
      success: true,
      message: "Delivery note confirmed successfully",
      data: deliveryNote,
    });
  } catch (error) {
    next(error);
  }
};

// Helper: Create COGS adjustment journal entry
async function createCOGSAdjustmentEntry(
  companyId,
  userId,
  data,
  options = {},
) {
  const { product, deliveryNote, line, difference } = data;
  const isIncrease = difference > 0;

  // Get accounts from product
  const cogsAccount = product.cogsAccount || product.cogs_account_id;
  const inventoryAccount =
    product.inventoryAccount || product.inventory_account_id;

  if (!cogsAccount || !inventoryAccount) {
    console.warn("Missing COGS or Inventory account for product:", product._id);
    return;
  }

  // Get account names
  const {
    getAccount,
    DEFAULT_ACCOUNTS,
  } = require("../constants/chartOfAccounts");
  const cogsAccountName = getAccount(cogsAccount)?.name || "Cost of Goods Sold";
  const inventoryAccountName =
    getAccount(inventoryAccount)?.name || "Inventory";

  const narration = `COGS Adjustment - ${line.productName} - DN#${deliveryNote.referenceNo} - cost variance`;

  const journalEntry = {
    date: new Date(),
    description: narration,
    sourceType: "cogs_adjustment",
    sourceId: deliveryNote._id,
    sourceReference: `DN-ADJ-${deliveryNote.referenceNo}`,
    lines: [
      {
        accountCode: isIncrease ? cogsAccount : inventoryAccount,
        accountName: isIncrease ? cogsAccountName : inventoryAccountName,
        debit: isIncrease ? Math.abs(difference) : 0,
        credit: isIncrease ? 0 : Math.abs(difference),
        description: narration,
      },
      {
        accountCode: isIncrease ? inventoryAccount : cogsAccount,
        accountName: isIncrease ? inventoryAccountName : cogsAccountName,
        debit: isIncrease ? 0 : Math.abs(difference),
        credit: isIncrease ? Math.abs(difference) : 0,
        description: narration,
      },
    ],
  };

  await JournalService.createEntry(companyId, userId, {
    ...journalEntry,
    session: options.session,
  });
}

// @desc    Dispatch delivery note (set delivery tracking info)
// @route   PUT /api/delivery-notes/:id/dispatch
// @access  Private
exports.dispatchDeliveryNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const deliveryNoteId = req.params.id;
    const { deliveredBy, vehicle, carrier, trackingNumber, deliveryAddress, deliveryDate } = req.body;

    const deliveryNote = await DeliveryNote.findOne({
      _id: deliveryNoteId,
      company: companyId,
    });

    if (!deliveryNote) {
      return res.status(404).json({
        success: false,
        code: ERR_DELIVERY_NOT_FOUND,
        message: "Delivery note not found",
      });
    }

    // Can only dispatch if status is draft or confirmed
    const dispatchableStatuses = ['draft', 'confirmed'];
    if (!dispatchableStatuses.includes(deliveryNote.status)) {
      return res.status(400).json({
        success: false,
        code: ERR_DELIVERY_CONFIRMED,
        message: `Cannot dispatch delivery note with status: ${deliveryNote.status}`,
      });
    }

    // Update delivery tracking information
    deliveryNote.deliveredBy = deliveredBy || deliveryNote.deliveredBy;
    deliveryNote.vehicle = vehicle || deliveryNote.vehicle;
    deliveryNote.carrier = carrier || deliveryNote.carrier;
    deliveryNote.trackingNumber = trackingNumber || deliveryNote.trackingNumber;
    deliveryNote.deliveryAddress = deliveryAddress || deliveryNote.deliveryAddress;
    if (deliveryDate) {
      deliveryNote.deliveryDate = new Date(deliveryDate);
    }

    // Change status to dispatched when dispatch button is clicked
    deliveryNote.status = 'dispatched';

    await deliveryNote.save();

    res.status(200).json({
      success: true,
      data: deliveryNote,
      message: "Delivery note dispatched successfully",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Mark delivery note as delivered
// @route   PUT /api/delivery-notes/:id/deliver
// @access  Private
exports.markDelivered = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const deliveryNoteId = req.params.id;
    const { receivedBy, receivedDate, notes } = req.body;

    const deliveryNote = await DeliveryNote.findOne({
      _id: deliveryNoteId,
      company: companyId,
    });

    if (!deliveryNote) {
      return res.status(404).json({
        success: false,
        code: ERR_DELIVERY_NOT_FOUND,
        message: "Delivery note not found",
      });
    }

    // Can only mark as delivered if status is dispatched
    if (deliveryNote.status !== 'dispatched') {
      return res.status(400).json({
        success: false,
        code: ERR_DELIVERY_CONFIRMED,
        message: `Cannot mark as delivered. Current status: ${deliveryNote.status}`,
      });
    }

    // Update delivery information
    if (receivedBy) deliveryNote.deliveredBy = receivedBy;
    if (receivedDate) deliveryNote.actualDeliveryDate = new Date(receivedDate);
    if (notes) deliveryNote.notes = notes;

    // Change status to delivered
    deliveryNote.status = 'delivered';

    await deliveryNote.save();

    res.status(200).json({
      success: true,
      data: deliveryNote,
      message: "Delivery note marked as delivered successfully",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Cancel confirmed delivery note (Module 7 - reverse stock)
// @route   POST /api/delivery-notes/:id/cancel
// @access  Private
exports.cancelDeliveryNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { cancellationReason } = req.body;

    let deliveryNote = await DeliveryNote.findOne({
      _id: req.params.id,
      company: companyId,
    })
      .populate("lines.product")
      .populate("warehouse");

    if (!deliveryNote) {
      return res.status(404).json({
        success: false,
        code: ERR_DELIVERY_NOT_FOUND,
        message: "Delivery note not found",
      });
    }

    // Only confirmed delivery notes can be cancelled
    if (deliveryNote.status !== "confirmed") {
      return res.status(400).json({
        success: false,
        code: ERR_DELIVERY_CONFIRMED,
        message: `Cannot cancel delivery note with status: ${deliveryNote.status}`,
      });
    }

    const invoice = await Invoice.findById(deliveryNote.invoice);
    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    const inventoryService = require("../services/inventoryService");

    // Execute reversal in transaction
    await runInTransaction(async (session) => {
      // Reverse each line
      for (const line of deliveryNote.lines) {
        if (line.deliveredQty <= 0) continue;

        const product = await Product.findOne({
          _id: line.product._id,
          company: companyId,
        }).session(session);
        if (!product) continue;

        const trackingType = product.trackingType || "none";

        // ========== Reverse stock consumption ==========
        if (trackingType === "none" || trackingType === "fifo") {
          // Reverse FIFO - add back to lots
          await inventoryService.reverseConsume(
            companyId,
            product._id,
            line.deliveredQty,
            { warehouse: deliveryNote.warehouse._id, session },
          );
        } else if (trackingType === "wac") {
          // WAC - stock level will be updated below
        } else if (trackingType === "batch" && line.batchId) {
          // Restore batch quantity
          const batch = await StockBatch.findById(line.batchId).session(
            session,
          );
          if (batch) {
            batch.qtyOnHand = (batch.qtyOnHand || 0) + line.deliveredQty;
            await batch.save({ session });
          }
        }

        // ========== Restore stock level ==========
        // Use direct update to avoid mongoose caching issues
        // Convert to Number to avoid string concatenation (Decimal128 + number = string concat!)
        const previousStock = Number(product.currentStock) || 0;
        const newStock = previousStock + Number(line.deliveredQty);
        await Product.findByIdAndUpdate(
          product._id,
          { currentStock: newStock },
          { session },
        );

        // ========== Reverse stock movement ==========
        await StockMovement.create(
          [
            {
              company: companyId,
              product: product._id,
              warehouse: deliveryNote.warehouse._id,
              type: "in",
              reason: "dispatch_reversal",
              quantity: line.deliveredQty,
              previousStock: newStock - line.deliveredQty,
              newStock: newStock,
              unitCost: line.unitCost || 0,
              totalCost: (line.unitCost || 0) * line.deliveredQty,
              sourceType: "delivery_note_cancellation",
              sourceId: deliveryNote._id,
              referenceNumber: deliveryNote.referenceNo,
              notes: `DN#${deliveryNote.referenceNo} Cancellation - ${line.productName}`,
              performedBy: req.user.id,
              movementDate: new Date(),
            },
          ],
          { session },
        );

        // ========== Restore serial status ==========
        if (
          trackingType === "serial" &&
          line.serialNumbers &&
          line.serialNumbers.length > 0
        ) {
          await StockSerialNumber.updateMany(
            { _id: { $in: line.serialNumbers } },
            {
              status: "in_stock",
              dispatchedVia: null,
              dispatchedAt: null,
            },
            { session },
          );
        }

        // ========== Reverse invoice qty_delivered ==========
        const invoiceLine = invoice.lines.id(line.invoiceLineId);
        if (invoiceLine) {
          invoiceLine.qtyDelivered = Math.max(
            0,
            (invoiceLine.qtyDelivered || 0) - line.deliveredQty,
          );
        }
      }

      // Save invoice
      await invoice.save({ session });

      // ========== Reverse COGS adjustment if exists ==========
      // Find COGS adjustment journal entries for this delivery note
      const cogsAdjustments = await mongoose
        .model("JournalEntry")
        .find({
          company: companyId,
          sourceType: "cogs_adjustment",
          sourceId: deliveryNote._id,
        })
        .session(session);

      // Aggregate reversal entries and mark originals as reversed, then post atomically
      const reversalEntries = [];
      for (const adjEntry of cogsAdjustments) {
        // Mark original entry as reversed
        adjEntry.status = "reversed";
        adjEntry.reversalDate = new Date();
        adjEntry.reversedBy = req.user.id;
        await adjEntry.save({ session });

        // Build reverse journal entry options
        const reverseLines = adjEntry.lines.map((e) => ({
          accountCode: e.accountCode,
          accountName: e.accountName,
          debit: e.credit,
          credit: e.debit,
          description: `Reversed: ${e.description}`,
        }));

        reversalEntries.push({
          date: new Date(),
          description: `Reversal of COGS Adjustment - DN#${deliveryNote.referenceNo}`,
          sourceType: "cogs_adjustment_reversal",
          sourceId: deliveryNote._id,
          sourceReference: `DN-ADJ-REV-${deliveryNote.referenceNo}`,
          lines: reverseLines,
          isAutoGenerated: true,
        });
      }

      if (reversalEntries.length > 0) {
        await JournalService.createEntriesAtomic(
          companyId,
          req.user.id,
          reversalEntries,
          { session },
        );
      }

      // Update delivery note status
      deliveryNote.status = "cancelled";
      deliveryNote.cancellationReason = cancellationReason;
      deliveryNote.cancelledBy = req.user.id;
      deliveryNote.cancelledDate = new Date();
      deliveryNote.stockDeducted = false;
      await deliveryNote.save({ session });
    });

    await deliveryNote.populate(
      "lines.product warehouse createdBy cancelledBy invoice",
    );

    res.json({
      success: true,
      message: "Delivery note cancelled successfully",
      data: deliveryNote,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create invoice from delivery note (NEW WORKFLOW)
// @route   POST /api/delivery-notes/:id/create-invoice
// @access  Private
exports.createInvoiceFromDeliveryNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { dueDate, paymentTerms, notes, terms, confirmDelivery } = req.body;

    let deliveryNote = await DeliveryNote.findOne({
      _id: req.params.id,
      company: companyId,
    })
      .populate("lines.product")
      .populate("items.product")
      .populate("client")
      .populate("salesOrder");

    if (!deliveryNote) {
      return res.status(404).json({
        success: false,
        message: "Delivery note not found",
      });
    }

    // NEW WORKFLOW: Allow invoice creation from draft delivery notes created via Pick Pack
    // OLD WORKFLOW: Only from delivered/partial status
    const isNewWorkflow =
      deliveryNote.sourceType === "pick_pack" || !deliveryNote.invoice;
    const isOldWorkflow = ["delivered", "partial"].includes(
      deliveryNote.status,
    );

    if (!isNewWorkflow && !isOldWorkflow) {
      return res.status(400).json({
        success: false,
        message:
          "Delivery note must be confirmed (delivered/partial) or created via Pick Pack to generate invoice",
      });
    }

    if (deliveryNote.invoice) {
      const existingId = deliveryNote.invoice._id || deliveryNote.invoice;
      const existingInvoice = await Invoice.findOne({
        _id: existingId,
        company: companyId,
      })
        .populate("client createdBy lines.product");

      if (confirmDelivery && deliveryNote.status === "draft") {
        deliveryNote.status = "confirmed";
        deliveryNote.confirmedBy = req.user.id;
        deliveryNote.confirmedDate = new Date();
        await deliveryNote.save();
      }

      return res.status(200).json({
        success: true,
        message: "Invoice already exists for this delivery note",
        data: existingInvoice,
      });
    }

    // Use lines (new) or items (legacy)
    const lineArray =
      deliveryNote.lines && deliveryNote.lines.length > 0
        ? deliveryNote.lines
        : deliveryNote.items || [];

    // Process lines for invoice - use qtyToDeliver (or deliveredQty for legacy)
    const processedLines = lineArray
      .map((line, idx) => {
        const quantity = line.qtyToDeliver || line.deliveredQty || 0;
        const product = line.product;
        if (!product) return null;

        // Use the unitPrice from the delivery note line (set from SO/Quotation), fallback to product.sellingPrice
        const unitPrice = line.unitPrice || product.sellingPrice || 0;
        const subtotal = quantity * unitPrice;
        const discountPct = 0;
        const netAmount = subtotal;
        const taxRate = product.taxRate || 0;
        const taxCode = product.taxCode || "A";
        const taxAmount = netAmount * (taxRate / 100);
        const totalWithTax = netAmount + taxAmount;

        return {
          product: product._id,
          productCode: product.sku || `ITEM-${idx + 1}`,
          productName: line.productName || product.name || "",
          description: line.productName || product.name || "",
          qty: quantity,
          unit: line.unit || product.unit || "",
          unitPrice,
          discountPct,
          taxCode,
          taxRate,
          taxAmount,
          lineTax: taxAmount,
          lineSubtotal: subtotal,
          lineTotal: totalWithTax,
          warehouse: deliveryNote.warehouse,
        };
      })
      .filter((line) => line && line.qty > 0);

    if (processedLines.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No items with delivery quantity to create invoice",
      });
    }

    const headerSubtotal = processedLines.reduce((s, l) => s + Number(l.lineSubtotal || 0), 0);
    const headerTax = processedLines.reduce((s, l) => s + Number(l.lineTax || 0), 0);
    const headerTotal = processedLines.reduce((s, l) => s + Number(l.lineTotal || 0), 0);

    // Prefer company base currency, then DN currency, then RWF
    let currencyCode = deliveryNote.currencyCode || "RWF";
    try {
      const Company = require("../models/Company");
      const company = await Company.findById(companyId).select("baseCurrency currencyCode currency");
      currencyCode =
        company?.baseCurrency ||
        company?.currencyCode ||
        company?.currency ||
        deliveryNote.currencyCode ||
        "RWF";
    } catch (_) {
      /* keep fallback */
    }

    // Create invoice with links to Sales Order and Delivery Note
    const invoice = await Invoice.create({
      company: companyId,
      client: deliveryNote.client._id,
      salesOrder: deliveryNote.salesOrder?._id,
      deliveryNote: deliveryNote._id,
      quotation: deliveryNote.quotation,
      lines: processedLines,
      currencyCode,
      currency: currencyCode,
      subtotal: headerSubtotal,
      taxAmount: headerTax,
      totalAmount: headerTotal,
      grandTotal: headerTotal,
      amountOutstanding: headerTotal,
      terms: terms || "",
      notes: notes || deliveryNote.notes,
      createdBy: req.user.id,
      dueDate: dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      paymentTerms: paymentTerms || "credit_30",
      autoConfirm: false, // Stay as draft until explicitly confirmed
    });

    // Update delivery note with invoice reference
    deliveryNote.invoice = invoice._id;

    // Map created invoice lines back to delivery note lines (set invoiceLineId)
    // This ensures later delivery confirmation can lookup corresponding invoice lines.
    try {
      if (invoice.lines && invoice.lines.length > 0) {
        const invoiceLines = invoice.lines;
        let invIdx = 0;
        for (const ln of lineArray) {
          const qty = ln.qtyToDeliver || ln.deliveredQty || 0;
          if (!qty || qty <= 0) continue;
          const invLine = invoiceLines[invIdx];
          if (invLine) {
            ln.invoiceLineId = invLine._id;
          }
          invIdx++;
        }
      }
    } catch (e) {
      // Non-fatal - continue without back-mapping if something goes wrong
      console.warn("Failed to map invoice lines to delivery note lines:", e);
    }

    // If requested, also confirm the delivery note
    if (confirmDelivery && deliveryNote.status === "draft") {
      deliveryNote.status = "confirmed";
      deliveryNote.confirmedBy = req.user.id;
      deliveryNote.confirmedDate = new Date();
    }

    await deliveryNote.save();

    // Update Sales Order with invoice reference
    if (deliveryNote.salesOrder) {
      const SalesOrder = require("../models/SalesOrder");
      await SalesOrder.findByIdAndUpdate(deliveryNote.salesOrder._id, {
        $addToSet: { invoices: invoice._id },
        status: "invoiced",
      });
    }

    await invoice.populate("client createdBy");

    res.status(201).json({
      success: true,
      message: "Invoice created successfully from delivery note",
      data: invoice,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get delivery notes for a specific invoice (Module 7)
// @route   GET /api/delivery-notes/invoice/:invoiceId
// @access  Private
exports.getInvoiceDeliveryNotes = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const deliveryNotes = await DeliveryNote.find({
      invoice: req.params.invoiceId,
      company: companyId,
    })
      .populate("client", "name code")
      .populate("warehouse", "name code")
      .populate("lines.product", "name sku")
      .populate("createdBy", "name email")
      .populate("confirmedBy", "name email")
      .populate("invoice", "currencyCode")
      .sort({ createdAt: -1 });

    // Enhance with computed fields for frontend compatibility
    deliveryNotes = enhanceDeliveryNotes(deliveryNotes);

    res.json({
      success: true,
      count: deliveryNotes.length,
      data: deliveryNotes,
    });
  } catch (error) {
    next(error);
  }
};

// Legacy: Get delivery notes for a specific quotation
// @route   GET /api/delivery-notes/quotation/:quotationId
exports.getQuotationDeliveryNotes = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const deliveryNotes = await DeliveryNote.find({
      quotation: req.params.quotationId,
      company: companyId,
    })
      .populate("client", "name code")
      .populate("items.product", "name sku")
      .populate("createdBy", "name email")
      .populate("invoice", "currencyCode")
      .sort({ createdAt: -1 });

    // Enhance with computed fields for frontend compatibility
    deliveryNotes = enhanceDeliveryNotes(deliveryNotes);

    res.json({
      success: true,
      count: deliveryNotes.length,
      data: deliveryNotes,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Generate delivery note PDF
// @route   GET /api/delivery-notes/:id/pdf
// @access  Private
exports.generateDeliveryNotePDF = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const deliveryNote = await DeliveryNote.findOne({
      _id: req.params.id,
      company: companyId,
    })
      .populate("client")
      .populate("quotation")
      .populate("items.product")
      .populate("company");

    if (!deliveryNote) {
      return res.status(404).json({
        success: false,
        message: "Delivery note not found",
      });
    }

    // Create PDF document
    const doc = new PDFDocument({ margin: 50 });

    // Set response headers
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=delivery-note-${deliveryNote.deliveryNumber}.pdf`,
    );

    // Pipe PDF to response
    doc.pipe(res);

    // Layout helpers
    const left = 48;
    const right = 48;
    const availWidth = doc.page.width - left - right;
    const bottomLimit = doc.page.height - 80;

    let pageNum = 1;
    const drawFooter = (p) => {
      const bottom = doc.page.height - 40;
      doc.fontSize(8).fillColor("#9ca3af").font("Helvetica");
      doc.text(`Generated: ${new Date().toLocaleString()}`, left, bottom, {
        align: "left",
      });
      doc.text(`Page ${p}`, 0, bottom, { align: "right" });
    };

    const renderHeader = () => {
      // Header with logo area and title
      doc
        .fontSize(24)
        .fillColor("#111827")
        .text("NOTE DE LIVRAISON", { align: "center" });
      doc.moveDown(0.3);

      doc
        .fontSize(14)
        .fillColor("#6b7280")
        .text(`N°: ${deliveryNote.deliveryNumber}`, { align: "center" });
      doc.moveDown(0.8);

      // Company and Client info
      const startY = doc.y;
      const lineHeight = 14;

      // Left column - Supplier (You)
      doc.fontSize(10).fillColor("#111827").font("Helvetica-Bold");
      doc.text("FOURNISSEUR (You):", left, startY);
      doc.font("Helvetica").fontSize(10).fillColor("#374151");
      doc.text(
        deliveryNote.company?.name || "Company Name",
        left,
        startY + lineHeight,
      );
      doc.text(
        deliveryNote.company?.taxId ? `TIN: ${deliveryNote.company.taxId}` : "",
        left,
        startY + lineHeight * 2,
      );
      doc.text(
        deliveryNote.company?.address || "",
        left,
        startY + lineHeight * 3,
      );

      // Right column - Client
      const clientX = left + Math.floor(availWidth * 0.55);
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#111827");
      doc.text("CLIENT:", clientX, startY);
      doc.font("Helvetica").fontSize(10).fillColor("#374151");
      doc.text(deliveryNote.client?.name || "", clientX, startY + lineHeight);
      doc.text(
        deliveryNote.client?.taxId ? `TIN: ${deliveryNote.client.taxId}` : "",
        clientX,
        startY + lineHeight * 2,
      );
      doc.text(
        deliveryNote.client?.contact?.address ||
          deliveryNote.customerAddress ||
          "",
        clientX,
        startY + lineHeight * 3,
      );

      doc.moveDown(3);

      // Date and Reference row
      doc.fontSize(10).fillColor("#111827");
      doc.text(
        `Date: ${new Date(deliveryNote.deliveryDate).toLocaleDateString()}`,
        left,
      );
      if (deliveryNote.quotation) {
        doc.text(
          `Référence: ${deliveryNote.quotation.quotationNumber || "N/A"}`,
          left + 200,
        );
      }
      doc.moveDown(0.5);

      // Driver info
      if (deliveryNote.deliveredBy || deliveryNote.vehicle) {
        doc.text(
          `Chauffeur: ${deliveryNote.deliveredBy || "___"}    Véhicule: ${deliveryNote.vehicle || "___"}`,
        );
        doc.moveDown(0.5);
      }
    };

    // Table columns: No, Product, Unit, Ordered, Delivered
    const colPercents = [0.08, 0.42, 0.12, 0.18, 0.2];
    const colWidths = colPercents.map((p) => Math.floor(availWidth * p));
    const sumCols = colWidths.reduce((s, v) => s + v, 0);
    if (sumCols < availWidth)
      colWidths[colWidths.length - 1] += availWidth - sumCols;

    const renderTableHeader = (y) => {
      doc.rect(left - 8, y, availWidth + 16, 28).fill("#111827");
      doc.fillColor("#ffffff").fontSize(10).font("Helvetica-Bold");
      let x = left;
      const headers = ["No.", "Produit", "Unité", "Commandé", "Livré"];
      headers.forEach((h, i) => {
        const align = i >= 3 ? "right" : "left";
        doc.text(h, x, y + 8, { width: colWidths[i], align });
        x += colWidths[i];
      });
      doc.fillColor("#111827").font("Helvetica");
    };

    // Print header and table header
    renderHeader();
    let y = doc.y;
    renderTableHeader(y);
    y += 34;

    // Items
    doc.fontSize(9).font("Helvetica");
    for (let idx = 0; idx < deliveryNote.items.length; idx++) {
      const item = deliveryNote.items[idx];
      const productName = item.productName || item.product?.name || "";
      const unit = item.unit || item.product?.unit || "";
      const orderedQty = item.orderedQty || 0;
      const deliveredQty = item.deliveredQty || 0;

      // Measure heights
      const hNo = doc.heightOfString(String(idx + 1), { width: colWidths[0] });
      const hProduct = doc.heightOfString(productName, { width: colWidths[1] });
      const hUnit = doc.heightOfString(unit, { width: colWidths[2] });
      const hOrdered = doc.heightOfString(String(orderedQty), {
        width: colWidths[3],
      });
      const hDelivered = doc.heightOfString(String(deliveredQty), {
        width: colWidths[4],
      });
      const rowHeight = Math.max(
        hNo,
        hProduct,
        hUnit,
        hOrdered,
        hDelivered,
        14,
      );

      // Page break if needed
      if (y + rowHeight > bottomLimit) {
        drawFooter(pageNum);
        doc.addPage();
        pageNum += 1;
        renderHeader();
        y = doc.y;
        renderTableHeader(y);
        y += 34;
      }

      // Alternating shading
      if (idx % 2 === 0) {
        doc
          .rect(left - 8, y - 6, availWidth + 16, rowHeight + 8)
          .fill("#f9fafb");
        doc.fillColor("#111827");
      }

      // Render cells
      let x = left;
      doc.text(String(idx + 1), x, y, { width: colWidths[0] });
      x += colWidths[0];
      doc.text(productName, x, y, { width: colWidths[1] });
      x += colWidths[1];
      doc.text(unit, x, y, { width: colWidths[2] });
      x += colWidths[2];
      doc.text(String(orderedQty), x, y, {
        width: colWidths[3],
        align: "right",
      });
      x += colWidths[3];
      doc.text(String(deliveredQty), x, y, {
        width: colWidths[4],
        align: "right",
      });

      y += rowHeight + 8;
    }

    // Notes section
    y += 10;
    const hasNotes =
      deliveryNote.notes ||
      (deliveryNote.items && deliveryNote.items.some((i) => i.notes));
    if (hasNotes) {
      if (y + 60 > bottomLimit) {
        drawFooter(pageNum);
        doc.addPage();
        pageNum += 1;
        y = 50;
      }

      doc.fontSize(10).font("Helvetica-Bold").fillColor("#111827");
      doc.text("Notes:", left, y);
      doc.font("Helvetica").fontSize(9).fillColor("#374151");

      let notesText = deliveryNote.notes || "";

      // Add item-specific notes (backorders, etc.)
      deliveryNote.items.forEach((item) => {
        if (item.notes) {
          notesText += `\n- ${item.productName}: ${item.notes}`;
        }
        if (item.pendingQty > 0) {
          notesText += `\n- ${item.productName}: ${item.pendingQty} en attente`;
        }
      });

      doc.text(notesText, left, y + 14, { width: availWidth });
      y += 40;
    }

    // Delivery confirmation section
    y += 10;
    if (y + 100 > bottomLimit) {
      drawFooter(pageNum);
      doc.addPage();
      pageNum += 1;
    }

    // Signature boxes
    const boxWidth = Math.floor(availWidth / 2) - 10;
    const boxHeight = 80;

    // Delivered by box
    doc
      .rect(left, y, boxWidth, boxHeight)
      .strokeColor("#e5e7eb")
      .lineWidth(0.5)
      .stroke();
    doc.fontSize(10).font("Helvetica-Bold").fillColor("#111827");
    doc.text("LIVRÉ PAR:", left + 8, y + 8);
    doc.font("Helvetica").fontSize(9).fillColor("#374151");
    doc.text(
      `Nom: ${deliveryNote.deliveredBy || "_______________"}`,
      left + 8,
      y + 28,
    );
    doc.text(`Signature: _______________`, left + 8, y + 42);
    doc.text(
      `Date: ${deliveryNote.deliveryDate ? new Date(deliveryNote.deliveryDate).toLocaleDateString() : "_______________"}`,
      left + 8,
      y + 56,
    );

    // Received by client box
    doc
      .rect(left + boxWidth + 20, y, boxWidth, boxHeight)
      .strokeColor("#e5e7eb")
      .lineWidth(0.5)
      .stroke();
    doc.fontSize(10).font("Helvetica-Bold").fillColor("#111827");
    doc.text("REÇU PAR LE CLIENT:", left + boxWidth + 28, y + 8);
    doc.font("Helvetica").fontSize(9).fillColor("#374151");
    doc.text(
      `Nom: ${deliveryNote.receivedBy || "_______________"}`,
      left + boxWidth + 28,
      y + 28,
    );
    doc.text(`Signature: _______________`, left + boxWidth + 28, y + 42);
    doc.text(
      `Date: ${deliveryNote.receivedDate ? new Date(deliveryNote.receivedDate).toLocaleDateString() : "_______________"}`,
      left + boxWidth + 28,
      y + 56,
    );
    if (deliveryNote.clientStamp) {
      doc.text(`Cachet: ✓`, left + boxWidth + 28, y + 70);
    }

    drawFooter(pageNum);
    doc.end();
  } catch (error) {
    next(error);
  }
};

// @desc    Update item delivery quantity (for lines array - Module 7)
// @route   PUT /api/delivery-notes/:id/lines/:lineId
// @access  Private
exports.updateLineDeliveryQty = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { qtyToDeliver, batchId, serialNumbers, notes } = req.body;

    const deliveryNote = await DeliveryNote.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!deliveryNote) {
      return res.status(404).json({
        success: false,
        message: "Delivery note not found",
      });
    }

    if (deliveryNote.status !== "draft") {
      return res.status(409).json({
        success: false,
        code: ERR_DELIVERY_CONFIRMED,
        message: "Cannot update lines on confirmed delivery note",
      });
    }

    const lineIndex = deliveryNote.lines.findIndex(
      (line) => line._id.toString() === req.params.lineId,
    );

    if (lineIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "Line not found",
      });
    }

    // Validate against invoice remaining qty
    const invoice = await Invoice.findById(deliveryNote.invoice);
    if (invoice) {
      const invoiceLine = invoice.lines.id(
        deliveryNote.lines[lineIndex].invoiceLineId,
      );
      if (invoiceLine) {
        const alreadyDelivered = invoiceLine.qtyDelivered || 0;
        const remainingQty = invoiceLine.quantity - alreadyDelivered;
        if (qtyToDeliver > remainingQty) {
          return res.status(422).json({
            success: false,
            code: ERR_EXCEEDS_INVOICE_QTY,
            message: "qty_to_deliver exceeds remaining invoice qty",
          });
        }
      }
    }

    if (qtyToDeliver !== undefined) {
      deliveryNote.lines[lineIndex].qtyToDeliver = qtyToDeliver;
      deliveryNote.lines[lineIndex].pendingQty = qtyToDeliver;
    }
    if (batchId) {
      deliveryNote.lines[lineIndex].batchId = batchId;
    }
    if (serialNumbers) {
      deliveryNote.lines[lineIndex].serialNumbers = serialNumbers;
    }
    if (notes) {
      deliveryNote.lines[lineIndex].notes = notes;
    }

    await deliveryNote.save();

    await deliveryNote.populate("lines.product warehouse createdBy invoice");

    res.json({
      success: true,
      data: deliveryNote,
    });
  } catch (error) {
    next(error);
  }
};

// Legacy: Update item delivery quantity (for items array - backwards compatibility)
// @route   PUT /api/delivery-notes/:id/items/:itemId
exports.updateItemDeliveryQty = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { deliveredQty, notes } = req.body;

    const deliveryNote = await DeliveryNote.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!deliveryNote) {
      return res.status(404).json({
        success: false,
        message: "Delivery note not found",
      });
    }

    if (!["draft", "dispatched"].includes(deliveryNote.status)) {
      return res.status(400).json({
        success: false,
        message: "Cannot update items on confirmed delivery note",
      });
    }

    const itemIndex = deliveryNote.items.findIndex(
      (item) => item._id.toString() === req.params.itemId,
    );

    if (itemIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "Item not found",
      });
    }

    // Validate quantity
    if (deliveredQty > deliveryNote.items[itemIndex].orderedQty) {
      return res.status(400).json({
        success: false,
        message: "Delivered quantity cannot exceed ordered quantity",
      });
    }

    deliveryNote.items[itemIndex].deliveredQty = deliveredQty;
    deliveryNote.items[itemIndex].pendingQty =
      deliveryNote.items[itemIndex].orderedQty - deliveredQty;
    if (notes) {
      deliveryNote.items[itemIndex].notes = notes;
    }

    await deliveryNote.save();

    await deliveryNote.populate("client items.product createdBy");

    res.json({
      success: true,
      data: deliveryNote,
    });
  } catch (error) {
    next(error);
  }
};
