const mongoose = require("mongoose");
const GoodsReceivedNote = require("../models/GoodsReceivedNote");
const PurchaseOrder = require("../models/PurchaseOrder");
const PurchaseReturn = require("../models/PurchaseReturn");
const Warehouse = require("../models/Warehouse");
const InventoryBatch = require("../models/InventoryBatch");
const StockBatch = require("../models/StockBatch");
const StockSerialNumber = require("../models/StockSerialNumber");
const StockMovement = require("../models/StockMovement");
const Product = require("../models/Product");
const { loadLineProducts, getLineProduct } = require("../utils/lineProducts");
const { emitDataChanged } = require("../lib/realtimeEvents");
const Supplier = require("../models/Supplier");
const Company = require("../models/Company");
const { generateUniqueNumber } = require('../models/utils/autoIncrement');
const JournalService = require("../services/journalService");
const TaxAutomationService = require("../services/taxAutomationService");
const transactionService = require("../services/transactionService");
const cacheService = require("../services/cacheService");
const emailService = require("../services/emailService");
const EBMPurchaseService = require("../services/ebmPurchaseService");
const EBMStockService = require("../services/ebmStockService");
const DEFAULT_ACCOUNTS =
  require("../constants/chartOfAccounts").DEFAULT_ACCOUNTS;
const StockLevel = require("../models/StockLevel");
const { toIdString } = require("../utils/objectId");
const { parseBoundedPage } = require("../utils/querySafety");
const { normalizeGRNLinesFromPurchaseOrder } = require("../utils/purchaseReceiptRules");

function resolveRefId(value) {
  return toIdString(value);
}

function resolveCompanyId(req) {
  return (
    req.user?.company?._id ||
    req.user?.company?.id ||
    req.user?.company ||
    req.company?._id ||
    req.company?.id ||
    req.headers['x-company-id'] ||
    null
  );
}

function resolveLineProductId(line) {
  return toIdString(line?.product) || toIdString(line?.productId);
}

function normalizeGrnRefs(grn) {
  if (!grn) return grn;
  grn.warehouse = resolveRefId(grn.warehouse) || grn.warehouseId || grn.warehouse;
  grn.purchaseOrder = resolveRefId(grn.purchaseOrder) || grn.purchaseOrderId || grn.purchaseOrder;
  grn.supplier = resolveRefId(grn.supplier) || grn.supplierId || grn.supplier;
  if (Array.isArray(grn.lines)) {
    for (const line of grn.lines) {
      line.product = resolveLineProductId(line);
      if (line.purchaseOrderLine != null) {
        line.purchaseOrderLine = resolveRefId(line.purchaseOrderLine);
      }
    }
  }
  return grn;
}

function computeGrnTotal(grn) {
  let totalAmount = (grn.lines || []).reduce(
    (sum, line) => {
      const lineSubtotal = Number(line.qtyReceived || 0) * Number(line.unitCost || 0);
      const lineTax = line.taxAmount != null
        ? Number(line.taxAmount) || 0
        : lineSubtotal * (Number(line.taxRate || 0) / 100);
      return sum + lineSubtotal + lineTax;
    },
    0,
  );
  const freightAmt = Number(grn.freight?.actualAmount) || 0;
  if (freightAmt > 0) {
    totalAmount += freightAmt;
  }
  if (!totalAmount && grn.totalAmount != null && grn.totalAmount !== "") {
    totalAmount = Number(grn.totalAmount) || 0;
  }
  return totalAmount;
}

function poReceiptTotals(po) {
  const totalOrdered = (po.lines || []).reduce(
    (sum, line) => sum + Number(line.qtyOrdered || 0),
    0,
  );
  const totalReceived = (po.lines || []).reduce(
    (sum, line) => sum + Number(line.qtyReceived || 0),
    0,
  );
  return {
    totalOrdered,
    totalReceived,
    hasRemaining: totalReceived < totalOrdered,
  };
}

async function syncPoQtyReceivedFromConfirmedGrns(po, companyId, { excludeGrnId } = {}) {
  for (const poLine of po.lines || []) {
    poLine.qtyReceived = 0;
  }

  const confirmedGrns = await GoodsReceivedNote.find({
    company: companyId,
    purchaseOrder: resolveRefId(po._id) || po._id,
    status: "confirmed",
  });

  for (const confirmedGrn of confirmedGrns) {
    if (excludeGrnId && String(confirmedGrn._id) === String(excludeGrnId)) continue;
    normalizeGrnRefs(confirmedGrn);
    for (const line of confirmedGrn.lines || []) {
      const poLine = po.lines.id(line.purchaseOrderLine);
      if (poLine) {
        poLine.qtyReceived =
          Number(poLine.qtyReceived || 0) + Number(line.qtyReceived || 0);
      }
    }
  }

  const { totalOrdered, totalReceived, hasRemaining } = poReceiptTotals(po);
  if (totalOrdered > 0) {
    po.status = hasRemaining
      ? totalReceived > 0
        ? "partially_received"
        : po.status === "approved"
          ? "approved"
          : "partially_received"
      : "fully_received";
  }

  return po;
}

function assertPoOpenForGrn(po, actionLabel = "confirm GRN") {
  const allowedStatuses = ["approved", "partially_received", "fully_received"];
  if (!allowedStatuses.includes(po.status)) {
    throw Object.assign(new Error(`PO must be approved to ${actionLabel}`), {
      status: 409,
    });
  }

  const { hasRemaining } = poReceiptTotals(po);
  if (!hasRemaining) {
    throw Object.assign(new Error("Purchase order is already fully received"), {
      status: 409,
    });
  }
}

function assertGrnLinesWithinPoRemaining(po, grnLines) {
  const seen = new Set();
  for (const line of grnLines || []) {
    const poLineId = resolveRefId(line.purchaseOrderLine);
    const poLine = (po.lines || []).find((candidate) => resolveRefId(candidate._id || candidate.id) === poLineId);
    if (!poLine) {
      throw Object.assign(new Error("Every GRN line must reference a line on the selected purchase order"), { status: 400 });
    }
    if (seen.has(poLineId)) {
      throw Object.assign(new Error("A purchase order line can only appear once per GRN"), { status: 400 });
    }
    seen.add(poLineId);
    if (resolveLineProductId(line) !== resolveRefId(poLine.product)) {
      throw Object.assign(new Error("GRN product does not match the selected purchase order line"), { status: 400 });
    }
    const remainingQty =
      Number(poLine.qtyOrdered || 0) - Number(poLine.qtyReceived || 0);
    const qtyReceived = Number(line.qtyReceived || 0);
    if (!Number.isFinite(qtyReceived) || qtyReceived <= 0) {
      throw Object.assign(new Error("Received quantities must be greater than zero"), { status: 400 });
    }
    if (qtyReceived > remainingQty) {
      throw Object.assign(
        new Error(
          `Qty received (${qtyReceived}) exceeds remaining qty (${remainingQty}) for product`,
        ),
        { status: 400 },
      );
    }
  }
}

function markPoLinesDirty(po) {
  if (Array.isArray(po.lines)) {
    po.lines = po.lines.map((line) => ({ ...line }));
  }
  return po;
}

const sendGRNEmail = async (grn, po, companyId) => {
  try {
    const config = require('../src/config/environment').getConfig();
    if (!config.features?.emailNotifications) {
      console.log('[GRN Email] Email notifications disabled');
      return;
    }

    const company = await Company.findById(companyId);
    const supplier = await Supplier.findById(grn.supplier);
    
    // Populate product data for email
    const grnWithProducts = await GoodsReceivedNote.findById(grn._id).populate('lines.product', 'name');
    
    if (supplier?.contact?.email || supplier?.email) {
      await emailService.sendGRNReceivedEmail(grnWithProducts, po, company, supplier);
    }
  } catch (err) {
    console.error('[GRN Email] Failed to send email:', err.message);
  }
};

// Create GRN (simple create against approved PO)
exports.createGRN = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      purchaseOrderId,
      warehouse,
      lines,
      referenceNo,
      supplierInvoiceNo,
      receivedDate,
      freight,
    } = req.body;

    const po = await PurchaseOrder.findOne({
      _id: purchaseOrderId,
      company: companyId,
    });
    if (!po)
      return res
        .status(404)
        .json({ success: false, message: "Purchase order not found" });

    await syncPoQtyReceivedFromConfirmedGrns(po, companyId);
    try {
      assertPoOpenForGrn(po, "create GRN");
    } catch (err) {
      return res
        .status(err.status || 409)
        .json({ success: false, message: err.message });
    }

    const enrichedLines = normalizeGRNLinesFromPurchaseOrder(po, lines);
    const warehouseId = resolveRefId(warehouse);
    if (!warehouseId) {
      return res.status(400).json({ success: false, message: "A receiving warehouse is required" });
    }
    const receivingWarehouse = await Warehouse.findOne({ _id: warehouseId, company: companyId, isActive: true });
    if (!receivingWarehouse) {
      return res.status(400).json({ success: false, message: "Invalid or inactive receiving warehouse" });
    }
    if (po.warehouse && resolveRefId(po.warehouse) !== warehouseId) {
      return res.status(400).json({ success: false, message: "Receiving warehouse must match the purchase order warehouse" });
    }

    // Auto-generate supplier invoice number when not provided
    let supplierInv = supplierInvoiceNo;
    if (!supplierInv) {
      // Use sequential supplier invoice number format e.g. SI-2026-00001
      supplierInv = await generateUniqueNumber('SI', GoodsReceivedNote, companyId, 'supplierInvoiceNo');
    }

    // Build freight payload: pre-fill from PO estimate if not provided by frontend
    let freightPayload = {};
    if (freight) {
      const actualFreightAmount = Number(freight.actualAmount ?? (po.freight && po.freight.amount) ?? 0);
      const allocationMethod = freight.allocationMethod || 'by_value';
      if (!Number.isFinite(actualFreightAmount) || actualFreightAmount < 0) {
        return res.status(400).json({ success: false, message: "Freight amount must be a non-negative number" });
      }
      if (!['by_value', 'by_quantity'].includes(allocationMethod)) {
        return res.status(400).json({ success: false, message: "Invalid freight allocation method" });
      }
      freightPayload = {
        carrier: freight.carrier || (po.freight && po.freight.carrier) || '',
        actualAmount: actualFreightAmount,
        paymentMethod: freight.paymentMethod || (po.freight && po.freight.paymentMethod) || 'on_account',
        account: freight.account || (po.freight && po.freight.account) || '5110',
        includeInInventoryCost: freight.includeInInventoryCost != null ? freight.includeInInventoryCost : (po.freight && po.freight.includeInInventoryCost) || false,
        allocationMethod,
        invoiceReference: freight.invoiceReference || '',
        invoiceDate: freight.invoiceDate ? new Date(freight.invoiceDate) : undefined,
        paidBy: freight.paidBy || 'company',
      };
    } else if (po.freight && (po.freight.amount || po.freight.carrier)) {
      freightPayload = {
        carrier: po.freight.carrier || '',
        actualAmount: po.freight.amount || 0,
        paymentMethod: po.freight.paymentMethod || 'on_account',
        account: po.freight.account || '5110',
        includeInInventoryCost: po.freight.includeInInventoryCost || false,
        allocationMethod: 'by_value',
        paidBy: 'company',
      };
    }

    const grn = await GoodsReceivedNote.create({
      company: companyId,
      referenceNo,
      purchaseOrder: po._id,
      warehouse: warehouseId,
      supplier: po.supplier,
      supplierInvoiceNo: supplierInv,
      receivedDate: receivedDate ? new Date(receivedDate) : undefined,
      lines: enrichedLines,
      freight: freightPayload,
      totalAmount: computeGrnTotal({ lines: enrichedLines, freight: freightPayload }),
      createdBy: req.user.id,
    });

    res.status(201).json({ success: true, data: grn });
  } catch (err) {
    next(err);
  }
};

// Confirm GRN: transactional stock updates + journal posting
exports.confirmGRN = async (req, res, next) => {
  const companyId = req.user.company._id;

  const runConfirm = async (sess) => {
    // sess may be null
    const useSession = !!sess;
    const findOpts = useSession ? { session: sess } : {};

    const grn = await GoodsReceivedNote.findOne(
      { _id: req.params.id, company: companyId },
      null,
      findOpts,
    );
    if (!grn) throw Object.assign(new Error("GRN not found"), { status: 404 });
    normalizeGrnRefs(grn);
    if (grn.status === "confirmed")
      throw Object.assign(new Error("GRN already confirmed"), { status: 400 });

    const po = await PurchaseOrder.findOne(
      { _id: grn.purchaseOrder, company: companyId },
      null,
      findOpts,
    );
    if (!po)
      throw Object.assign(new Error("Purchase order not found"), {
        status: 404,
      });

    await syncPoQtyReceivedFromConfirmedGrns(po, companyId, {
      excludeGrnId: grn._id,
    });
    grn.lines = normalizeGRNLinesFromPurchaseOrder(po, grn.lines || []);
    assertPoOpenForGrn(po, "confirm GRN");
    assertGrnLinesWithinPoRemaining(po, grn.lines);

    // ── Freight validation ───────────────────────────────────────────
    const freight = grn.freight || {};
    const freightAmount = Number(freight.actualAmount) || 0;
    const includeFreightInCost = !!freight.includeInInventoryCost;
    const freightAllocationMethod = freight.allocationMethod || 'by_value';

    if (freightAmount < 0) {
      throw Object.assign(new Error("Freight amount cannot be negative"), { status: 400 });
    }
    if (!Number.isFinite(freightAmount) || !['by_value', 'by_quantity'].includes(freightAllocationMethod)) {
      throw Object.assign(new Error("Invalid freight amount or allocation method"), { status: 400 });
    }

    // Validate freight invoice reference uniqueness
    if (freight.invoiceReference && freight.invoiceReference.trim()) {
      const existingGRN = await GoodsReceivedNote.findOne({
        company: companyId,
        _id: { $ne: grn._id },
        "freight.invoiceReference": freight.invoiceReference.trim(),
        status: "confirmed",
      }).session(sess || null);
      if (existingGRN) {
        throw Object.assign(new Error("Duplicate freight invoice reference detected"), { status: 409 });
      }
    }

    // Compute total goods value for allocation and warning checks
    const totalGoodsValue = grn.lines.reduce((s, l) => s + (Number(l.unitCost) * Number(l.qtyReceived)), 0);
    const totalQtyReceived = grn.lines.reduce((s, l) => s + Number(l.qtyReceived), 0);
    if (freightAmount > 0 && includeFreightInCost && totalGoodsValue <= 0) {
      throw Object.assign(new Error("Freight cannot be allocated to a receipt with no goods value"), { status: 400 });
    }
    if (freightAmount > 0 && includeFreightInCost && freightAllocationMethod === 'by_quantity' && totalQtyReceived <= 0) {
      throw Object.assign(new Error("Freight cannot be allocated without received quantities"), { status: 400 });
    }

    if (freightAmount > totalGoodsValue) {
      console.warn(`[GRN Confirm] Freight amount (${freightAmount}) exceeds goods value (${totalGoodsValue}) for GRN ${grn.referenceNo}`);
    }

    let journalLines = [];
    let vatTotal = 0;
    let apTotal = 0;
    const productTotals = new Map();
    const purchaseTaxLines = [];

    // Track created resources for manual rollback when not using DB transactions
    const createdBatches = [];
    const createdStockBatches = [];
    const createdSerialNumbers = [];
    const createdMovements = [];
    const updatedProducts = new Map(); // productId -> { previousStock, previousAvg }
    const updatedPOLines = [];

    // Both passes below walk the same lines, so the products are loaded once
    // here instead of once per line per pass — previously 2N round-trips for an
    // N-line receipt, all of them sequential.
    const grnLineProducts = await loadLineProducts(Product, grn.lines, companyId);

    // First pass: Validate tracking types and prepare batch/serial data
    for (const line of grn.lines) {
      const product = getLineProduct(grnLineProducts, line);

      if (!product) {
        throw Object.assign(new Error(`Product not found: ${resolveLineProductId(line)}`), {
          status: 404,
        });
      }

      // Ensure stockable products have a valid unit cost
      const isStockable =
        product.isStockable !== false && product.isStockable !== undefined
          ? product.isStockable
          : true;
      if (isStockable && (!line.unitCost || Number(line.unitCost) <= 0)) {
        throw Object.assign(
          new Error(
            `Unit cost must be greater than zero for stockable product ${product.name}`,
          ),
          { status: 400 },
        );
      }

      const trackingType = product.trackingType || "none";

      // Batch tracking: require batchNo
      if (trackingType === "batch") {
        if (!line.batchNo) {
          throw Object.assign(
            new Error(
              `Batch number required for product ${product.name} (tracking_type=batch)`,
            ),
            { status: 400 },
          );
        }
      }

      // Serial tracking: require serialNumbers array with count matching qtyReceived
      if (trackingType === "serial") {
        if (!line.serialNumbers || !Array.isArray(line.serialNumbers)) {
          throw Object.assign(
            new Error(
              `Serial numbers array required for product ${product.name} (tracking_type=serial)`,
            ),
            { status: 400 },
          );
        }
        if (line.serialNumbers.length !== line.qtyReceived) {
          throw Object.assign(
            new Error(
              `Serial numbers count (${line.serialNumbers.length}) must equal qty_received (${line.qtyReceived}) for product ${product.name}`,
            ),
            { status: 400 },
          );
        }
        const normalizedSerials = line.serialNumbers.map((serial) => String(serial).trim().toUpperCase());
        if (new Set(normalizedSerials).size !== normalizedSerials.length) {
          throw Object.assign(new Error(`Serial numbers must be unique within the receipt for product ${product.name}`), { status: 400 });
        }
      }
    }

    // ── Freight allocation across lines (Scenario B) ─────────────────
    if (freightAmount > 0 && includeFreightInCost && totalGoodsValue > 0) {
      for (const line of grn.lines) {
        const lineValue = Number(line.unitCost) * Number(line.qtyReceived);
        let allocatedFreight = 0;
        if (freightAllocationMethod === 'by_value') {
          allocatedFreight = freightAmount * (lineValue / totalGoodsValue);
        } else {
          // by_quantity
          allocatedFreight = freightAmount * (Number(line.qtyReceived) / totalQtyReceived);
        }
        const newUnitCost = lineValue > 0
          ? (lineValue + allocatedFreight) / Number(line.qtyReceived)
          : Number(line.unitCost);
        line.landedUnitCost = Math.round(newUnitCost * 1000000) / 1000000;
      }
    }
    for (const line of grn.lines) {
      if (line.landedUnitCost == null) line.landedUnitCost = Number(line.unitCost) || 0;
    }

    // Second pass: Process stock
    for (const line of grn.lines) {
      const product = getLineProduct(grnLineProducts, line);
      const trackingType = product.trackingType || "none";

      // Helper to parse date safely
      const parseLineDate = (dateVal) => {
        if (!dateVal) return null;
        if (dateVal instanceof Date) return dateVal;
        const parsed = new Date(dateVal);
        return isNaN(parsed.getTime()) ? null : parsed;
      };

      const lineMfgDate = parseLineDate(line.manufactureDate);
      const lineExpDate = parseLineDate(line.expiryDate);

      // Handle batch tracking
      if (trackingType === "batch" && line.batchNo) {
        // Check if batch already exists
        let stockBatch = await StockBatch.findOne(
          {
            company: companyId,
            product: line.product,
            warehouse: grn.warehouse,
            batchNo: line.batchNo.toUpperCase(),
          },
          null,
          useSession ? { session: sess } : {},
        );

        if (stockBatch) {
          // Update existing batch
          const oldQty = Number(stockBatch.qtyOnHand) || 0;
          const receivedQty = Number(line.qtyReceived) || 0;
          stockBatch.qtyOnHand = oldQty + receivedQty;
          stockBatch.qtyReceived = (Number(stockBatch.qtyReceived) || 0) + receivedQty;
          stockBatch.unitCost = stockBatch.qtyOnHand > 0
            ? ((oldQty * (Number(stockBatch.unitCost) || 0)) + (receivedQty * (Number(line.landedUnitCost) || 0))) / stockBatch.qtyOnHand
            : Number(line.landedUnitCost) || 0;
          // Update manufacture and expiry dates if provided
          if (lineMfgDate) {
            stockBatch.manufactureDate = lineMfgDate;
          }
          if (lineExpDate) {
            stockBatch.expiryDate = lineExpDate;
          }
          await stockBatch.save(useSession ? { session: sess } : {});
        } else {
          // Create new batch
          const mfgDate = lineMfgDate;
          const expDate = lineExpDate;
          
          stockBatch = new StockBatch({
            company: companyId,
            product: line.product,
            warehouse: grn.warehouse,
            grn: grn._id,
            batchNo: line.batchNo.toUpperCase(),
            qtyReceived: line.qtyReceived,
            qtyOnHand: line.qtyReceived,
            unitCost: line.landedUnitCost,
            manufactureDate: mfgDate,
            expiryDate: expDate,
            isQuarantined: false,
          });
          await stockBatch.save(useSession ? { session: sess } : {});
          createdStockBatches.push(stockBatch._id);
        }
      }

      // Handle serial number tracking
      if (
        trackingType === "serial" &&
        line.serialNumbers &&
        line.serialNumbers.length > 0
      ) {
        // One query for every serial on the line instead of one per serial.
        // A 100-unit serialised receipt was 100 sequential existence checks
        // before any stock moved. The loop below still reports the first
        // duplicate in the original order, so the error message is unchanged.
        const upperSerials = line.serialNumbers.map((sn) => String(sn).toUpperCase());
        const existingSerialRows = await StockSerialNumber.find({
          company: companyId,
          product: line.product,
          serialNo: { $in: upperSerials },
        });
        const existingSerialSet = new Set(
          (existingSerialRows || []).map((r) => String(r.serialNo).toUpperCase()),
        );

        for (const serialNo of line.serialNumbers) {
          const existingSerial = existingSerialSet.has(String(serialNo).toUpperCase());

          if (existingSerial) {
            throw Object.assign(
              new Error(
                `Serial number ${serialNo} already exists for product ${product.name}`,
              ),
              { status: 400 },
            );
          }

          const stockSerial = new StockSerialNumber({
            company: companyId,
            product: line.product,
            warehouse: grn.warehouse,
            grn: grn._id,
            serialNo: serialNo.toUpperCase(),
            unitCost: line.landedUnitCost,
            status: "in_stock",
          });
          await stockSerial.save(useSession ? { session: sess } : {});
          createdSerialNumbers.push(stockSerial._id);
        }
      }

      // Continue with existing InventoryBatch creation (for backward compatibility)
      const batch = new InventoryBatch({
        company: companyId,
        product: line.product,
        warehouse: grn.warehouse,
        quantity: line.qtyReceived,
        availableQuantity: line.qtyReceived,
        unitCost: line.landedUnitCost,
        receivedDate: grn.receivedDate,
        createdBy: req.user.id,
      });
      await batch.save(useSession ? { session: sess } : {});
      createdBatches.push(batch._id);

      // Product already fetched above, reuse it
      const previousStock = Number(product.currentStock || 0);
      const previousAvg = Number(product.averageCost || 0);
      if (!updatedProducts.has(String(product._id))) {
        updatedProducts.set(String(product._id), {
          previousStock,
          previousAvg,
        });
      }
      product.currentStock =
        Number(product.currentStock || 0) + Number(line.qtyReceived);

      // Always update averageCost using weighted average formula for display purposes
      const existingValue = (Number(product.averageCost) || 0) * previousStock;
      const receivedValue = Number(line.landedUnitCost) * Number(line.qtyReceived);
      const newQty = previousStock + Number(line.qtyReceived);
      product.averageCost =
        newQty > 0
          ? (existingValue + receivedValue) / newQty
          : product.averageCost;

      await product.save(useSession ? { session: sess } : {});

      // ── Upsert StockLevel (qty + WAC) for this product/warehouse ──────────
      try {
        const existingLevel = await StockLevel.findOne(
          {
            company_id: companyId,
            product_id: line.product,
            warehouse_id: grn.warehouse,
          },
          null,
          useSession ? { session: sess } : {},
        );
        const prevQtyOnHand = existingLevel
          ? existingLevel.qty_on_hand || 0
          : 0;
        const prevAvgCost = existingLevel ? existingLevel.avg_cost || 0 : 0;
        const recvQty = Number(line.qtyReceived);
        const recvCost = Number(line.landedUnitCost);
        const newQtyOnHand =
          Math.round((prevQtyOnHand + recvQty) * 10000) / 10000;
        const newAvgCost =
          newQtyOnHand > 0
            ? Math.round(
                ((prevQtyOnHand * prevAvgCost + recvQty * recvCost) /
                  newQtyOnHand) *
                  1000000,
              ) / 1000000
            : recvCost;
        const newTotalValue = Math.round(newQtyOnHand * newAvgCost * 100) / 100;

        await StockLevel.findOneAndUpdate(
          {
            company_id: companyId,
            product_id: line.product,
            warehouse_id: grn.warehouse,
          },
          {
            $set: {
              qty_on_hand: newQtyOnHand,
              avg_cost: newAvgCost,
              total_value: newTotalValue,
              last_movement_at: new Date(),
              last_movement_type: "receipt",
            },
            $setOnInsert: {
              qty_reserved: 0,
              qty_on_order: 0,
            },
          },
          { upsert: true, ...(useSession ? { session: sess } : {}) },
        );
      } catch (slErr) {
        throw Object.assign(
          new Error(`Unable to update warehouse stock level for GRN line: ${slErr.message}`),
          { status: 500 },
        );
      }

      const movement = new StockMovement({
        company: companyId,
        product: line.product,
        type: "in",
        reason: "purchase",
        quantity: line.qtyReceived,
        previousStock,
        newStock: product.currentStock,
        unitCost: line.landedUnitCost,
        totalCost: line.landedUnitCost * line.qtyReceived,
        warehouse: grn.warehouse,
        referenceType: "purchase_order",
        referenceNumber: po.referenceNo,
        referenceDocument: po._id,
        referenceModel: "PurchaseOrder",
        performedBy: req.user.id,
        movementDate: new Date(),
      });
      await movement.save(useSession ? { session: sess } : {});
      createdMovements.push(movement._id);

      const poLine = po.lines.id(line.purchaseOrderLine);
      if (poLine) {
        updatedPOLines.push({
          id: String(poLine._id),
          previousQty: poLine.qtyReceived || 0,
        });
        poLine.qtyReceived = (poLine.qtyReceived || 0) + line.qtyReceived;
      }

      const lineNet = Number(line.unitCost) * line.qtyReceived;
      const lineTaxRate = poLine && poLine.taxRate ? poLine.taxRate : 0;
      purchaseTaxLines.push({ netAmount: lineNet, taxRatePct: lineTaxRate });

      const prev = productTotals.get(String(line.product)) || 0;
      productTotals.set(
        String(line.product),
        prev + Number(line.landedUnitCost) * Number(line.qtyReceived),
      );
    }

    const totalOrdered = po.lines.reduce((s, l) => s + (l.qtyOrdered || 0), 0);
    const totalReceived = po.lines.reduce(
      (s, l) => s + (l.qtyReceived || 0),
      0,
    );
    const wasFullyReceived = totalReceived >= totalOrdered;
    po.status = wasFullyReceived ? "fully_received" : "partially_received";
    markPoLinesDirty(po);
    await po.save(useSession ? { session: sess } : {});

    // Recognize project/budget actuals as each receipt is confirmed, including
    // partial deliveries. This leaves only the unreceived commitment open.
    const BudgetService = require('../services/budgetService');
    for (const receivedLine of grn.lines || []) {
      const poLine = po.lines.id(receivedLine.purchaseOrderLine);
      if (!poLine?.encumbrance_id) continue; // Supports legacy POs created before budget integration.
      const netReceived = Number(receivedLine.qtyReceived || 0) * Number(receivedLine.unitCost || 0);
      const receivedTotal = Number((netReceived * (1 + (Number(poLine.taxRate) || 0) / 100)).toFixed(2));
      if (receivedTotal <= 0) continue;
      await BudgetService.liquidateEncumbrance(
        companyId,
        'purchase_order',
        po._id.toString(),
        {
          document_type: 'goods_received_note',
          document_id: grn._id.toString(),
          document_number: grn.referenceNo,
          amount: receivedTotal,
          encumbrance_id: poLine.encumbrance_id,
          budget_line_id: poLine.budget_line_id || undefined,
          notes: `GRN ${grn.referenceNo} confirmed${wasFullyReceived ? ' - order fully received' : ' - partial receipt'}`,
        },
        req.user.id,
      );
    }

    // Use TaxAutomationService for centralized tax computation
    const purchaseTax = await TaxAutomationService.computePurchaseTax(
      companyId,
      purchaseTaxLines,
    );

    // Build journal lines from TaxAutomationService output
    // Inventory lines (per product)
    // Products for every total in one query. This runs while building journal
    // lines, so it was one lookup per distinct product on the GRN.
    const journalProducts = await loadLineProducts(
      Product,
      [...productTotals.keys()].map((id) => ({ product: id })),
      companyId,
    );
    for (const [prodId, amt] of productTotals.entries()) {
      const product = getLineProduct(journalProducts, { product: prodId });
      let invAcct = DEFAULT_ACCOUNTS.inventory;
      if (product.inventoryAccount) {
        if (
          typeof product.inventoryAccount === "string" &&
          product.inventoryAccount.length === 24 &&
          /^[0-9a-fA-F]{24}$/.test(product.inventoryAccount)
        ) {
          // It's an ObjectId - resolve to account code
          const ChartOfAccounts = require("../models/ChartOfAccount");
          const acctDoc = await ChartOfAccounts.findById(
            product.inventoryAccount,
          ).lean();
          invAcct = acctDoc ? acctDoc.code : DEFAULT_ACCOUNTS.inventory;
        } else {
          invAcct = product.inventoryAccount;
        }
      } else {
        invAcct = await JournalService.getMappedAccountCode(
          companyId,
          "purchases",
          "inventory",
          DEFAULT_ACCOUNTS.inventory,
          { productId: prodId, warehouseId: grn.warehouse },
        );
      }
      journalLines.push(
        JournalService.createDebitLine(
          invAcct || DEFAULT_ACCOUNTS.inventory,
          amt,
          `Purchase ${po.referenceNo} - ${grn.referenceNo}`,
        ),
      );
    }

    // VAT Input line from TaxAutomationService
    if (purchaseTax.totals.tax > 0) {
      journalLines.push(
        JournalService.createDebitLine(
          DEFAULT_ACCOUNTS.vatInput || "2210",
          purchaseTax.totals.tax,
          `VAT Input for ${grn.referenceNo}`,
        ),
      );
    }

    // ── Freight journal line (Scenario A — posted as separate COGS line) ──
    if (freightAmount > 0 && !includeFreightInCost) {
      const freightAcct = freight.account || DEFAULT_ACCOUNTS.freightIn || '5110';
      journalLines.push(
        JournalService.createDebitLine(
          freightAcct,
          freightAmount,
          `Freight In for ${grn.referenceNo}${freight.carrier ? ' - ' + freight.carrier : ''}`,
        ),
      );
    }

    // Determine credit account based on freight payment method
    const paymentMethod = freight.paymentMethod || 'on_account';
    let creditAcct;
    if (paymentMethod === 'on_account') {
      creditAcct = await JournalService.getMappedAccountCode(
        companyId,
        "purchases",
        "accountsPayable",
        DEFAULT_ACCOUNTS.accountsPayable,
      );
    } else if (paymentMethod === 'cash') {
      creditAcct = DEFAULT_ACCOUNTS.cashInHand || '1000';
    } else if (paymentMethod === 'bank_transfer') {
      creditAcct = DEFAULT_ACCOUNTS.cashAtBank || '1100';
    } else if (paymentMethod === 'mobile_money') {
      creditAcct = DEFAULT_ACCOUNTS.mtnMoMo || '1200';
    } else {
      creditAcct = await JournalService.getMappedAccountCode(
        companyId,
        "purchases",
        "accountsPayable",
        DEFAULT_ACCOUNTS.accountsPayable,
      );
    }

    const creditTotal = purchaseTax.totals.gross + freightAmount;
    journalLines.push(
      JournalService.createCreditLine(
        creditAcct,
        creditTotal,
        `AP for ${po.referenceNo} / ${grn.referenceNo}`,
      ),
    );

    const supplier = await Supplier.findById(po.supplier).lean();
    const narration = `Purchase - ${supplier ? supplier.name : ""} - PO#${po.referenceNo} - GRN#${grn.referenceNo}`;

    let je;
    try {
      const created = await JournalService.createEntriesAtomic(
        companyId,
        req.user.id,
        [
          {
            date: new Date(),
            description: narration,
            sourceType: "purchase_order",
            sourceId: grn._id,
            sourceReference: `${po.referenceNo} / ${grn.referenceNo}`,
            lines: journalLines,
            isAutoGenerated: true,
            session: useSession ? sess : null,
          },
        ],
        { session: useSession ? sess : null },
      );
      je = created && created.length ? created[0] : null;
    } catch (jeErr) {
      // If we're not in a DB transaction, perform manual rollback of created resources
      if (!useSession) {
        try {
          // delete created movements
          if (createdMovements.length) {
            await StockMovement.deleteMany({ _id: { $in: createdMovements } });
          }
          // delete created batches
          if (createdBatches.length) {
            await InventoryBatch.deleteMany({ _id: { $in: createdBatches } });
          }
          // delete created stock batches (Module 4)
          if (createdStockBatches.length) {
            await StockBatch.deleteMany({ _id: { $in: createdStockBatches } });
          }
          // delete created serial numbers (Module 4)
          if (createdSerialNumbers.length) {
            await StockSerialNumber.deleteMany({
              _id: { $in: createdSerialNumbers },
            });
          }
          // restore product stocks and avg
          for (const [prodId, prev] of updatedProducts.entries()) {
            await Product.updateOne(
              { _id: prodId },
              {
                currentStock: prev.previousStock,
                averageCost: prev.previousAvg,
              },
            );
          }
          // restore PO lines
          for (const pl of updatedPOLines) {
            const lineDoc = po.lines.id(pl.id);
            if (lineDoc) lineDoc.qtyReceived = pl.previousQty;
          }
          // restore PO status
          po.status = "approved";
          await po.save();

          // leave GRN as draft (do not set journalEntry)
        } catch (rbErr) {
          console.error("Failed during manual rollback after JE error:", rbErr);
        }
      }
      // rethrow to caller
      throw jeErr;
    }

    grn.journalEntry = je._id;
    grn.status = "confirmed";
    grn.confirmedBy = req.user.id;
    grn.confirmedAt = new Date();

    // Keep the confirmed document value consistent with the displayed line tax
    // and freight treatment used by GRN reads and creation.
    grn.totalAmount = computeGrnTotal(grn);
    grn.balance = grn.totalAmount;
    grn.paymentStatus = "pending";

    await grn.save(useSession ? { session: sess } : {});
    // GRN confirmation is the AP recognition event. Record it in the same
    // PostgreSQL transaction as the stock and journal posting so retries cannot
    // leave the subledger behind the confirmed document.
    await require('../services/apTrackingService').recordGRNReceived(grn, req.user.id);

    return grn;
  };

  try {
    const result = await transactionService.runInTransaction(
      async (trx) => await runConfirm(trx),
    );
    try {
      await cacheService.bumpCompanyFinancialCaches(companyId);
    } catch (e) {
      console.error("Cache bump after GRN confirm failed:", e);
    }

    try {
      const poForEbm = await PurchaseOrder.findOne({
        _id: result.purchaseOrder,
        company: companyId,
      });
      if (poForEbm) {
        const processedPo = await EBMPurchaseService.processPurchaseDocument(companyId, poForEbm, "PurchaseOrder", {
          branchId: req.body.branchId || req.body.bhfId,
        });
        if (processedPo?.ebm?.ebmStatus !== "failed") {
          await EBMStockService.submitStockForGRN(result._id, {
            companyId,
            branchId: req.body.branchId || req.body.bhfId,
          });
        } else {
          console.warn("Skipping GRN EBM stock reporting because purchase confirmation failed permanently.");
        }
      }
    } catch (ebmErr) {
      console.error("EBM purchase/stock processing failed after GRN confirmation:", ebmErr.message);
    }

    // Send email notification for confirmed GRN (await & log result)
    const sendEmailOnConfirm = req.body.sendEmail || false;
    if (sendEmailOnConfirm) {
      try {
        const grnData = await GoodsReceivedNote.findById(result._id).populate('purchaseOrder');
        const poData = await PurchaseOrder.findById(grnData.purchaseOrder);
        const sent = await sendGRNEmail(grnData, poData, companyId);
        if (!sent) {
          console.warn(`GRN email not sent for GRN ${result._id} — sendGRNEmail returned false`);
        }
      } catch (emailErr) {
        console.error('Error sending GRN confirmation email:', emailErr);
      }
    }

    emitDataChanged(companyId, "grn", { affectsStock: true });
    await cacheService.bumpCompanyStockCaches(companyId);
    res.json({
      success: true,
      message: "GRN confirmed",
      data: await GoodsReceivedNote.findById(result._id),
    });
  } catch (err) {
    if (err && err.status)
      return res
        .status(err.status)
        .json({ success: false, message: err.message });
    next(err);
  }
};

// List GRNs with filters
exports.listGRNs = async (req, res, next) => {
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) {
      return res.status(400).json({ success: false, message: 'Company context required' });
    }
    const {
      supplier_id,
      status,
      ebmStatus,
      date_from,
      date_to,
    } = req.query;
    const { page, limit, skip } = parseBoundedPage(req.query, { defaultLimit: 20, maxLimit: 100 });

    const query = { company: companyId };

    if (supplier_id) query.supplier = supplier_id;
    if (status) query.status = status;
    if (ebmStatus) query["ebm.ebmStatus"] = ebmStatus;
    if (date_from || date_to) {
      query.receivedDate = {};
      if (date_from) query.receivedDate.$gte = new Date(date_from);
      if (date_to) query.receivedDate.$lte = new Date(date_to);
    }

    const grns = await GoodsReceivedNote.find(query)
      .populate("purchaseOrder", "referenceNo currencyCode")
      .populate("supplier", "name code")
      .populate("warehouse", "name code")
      .populate("createdBy", "name email")
      .populate("-lines")
      .select("_id company referenceNo purchaseOrder supplier warehouse receivedDate status supplierInvoiceNo totalAmount balance amountPaid paymentStatus paymentDueDate journalEntry freight ebm ebmImportReference createdBy confirmedBy confirmedAt createdAt updatedAt")
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await GoodsReceivedNote.countDocuments(query);

    // Calculate totalAmount for each GRN from lines (add freight if not absorbed)
    const grnsWithTotal = grns.map((grn) => ({
      ...grn,
      totalAmount: computeGrnTotal(grn),
    }));

    res.json({
      success: true,
      data: grnsWithTotal,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit)),
        total,
        limit: parseInt(limit),
      },
    });
  } catch (err) {
    next(err);
  }
};

// Update GRN (only for draft status)
exports.updateGRN = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;
    const { referenceNo, supplierInvoiceNo, receivedDate, lines, freight } = req.body;

    const grn = await GoodsReceivedNote.findOne({
      _id: id,
      company: companyId,
    });

    if (!grn) {
      return res.status(404).json({ success: false, message: "GRN not found" });
    }

    if (grn.status === "confirmed") {
      return res.status(409).json({
        success: false,
        message: "Cannot update confirmed GRN"
      });
    }

    if (referenceNo !== undefined) grn.referenceNo = referenceNo;
    if (supplierInvoiceNo !== undefined) grn.supplierInvoiceNo = supplierInvoiceNo;
    if (freight !== undefined) {
      grn.freight = {
        ...grn.freight,
        ...freight,
      };
    }

    if (receivedDate !== undefined) {
      const parsedDate = new Date(receivedDate);
      if (Number.isNaN(parsedDate.getTime())) {
        return res.status(400).json({ success: false, message: "Received date is invalid" });
      }
      grn.receivedDate = parsedDate;
    }

    if (lines !== undefined) {
      const po = await PurchaseOrder.findOne({ _id: grn.purchaseOrder, company: companyId });
      if (!po) return res.status(404).json({ success: false, message: "Purchase order not found" });
      await syncPoQtyReceivedFromConfirmedGrns(po, companyId);
      grn.lines = normalizeGRNLinesFromPurchaseOrder(po, lines);
    }

    await grn.save();

    res.json({ success: true, data: grn });
  } catch (err) {
    next(err);
  }
};

// Delete GRN (only for draft status)
exports.deleteGRN = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;

    const grn = await GoodsReceivedNote.findOne({
      _id: id,
      company: companyId,
    });

    if (!grn) {
      return res.status(404).json({ success: false, message: "GRN not found" });
    }

    if (grn.status === "confirmed") {
      return res.status(409).json({
        success: false,
        message: "Cannot delete confirmed GRN"
      });
    }

    await GoodsReceivedNote.findByIdAndDelete(id);

    res.json({ success: true, message: "GRN deleted successfully" });
  } catch (err) {
    next(err);
  }
};

// Get single GRN by ID
exports.getGRN = async (req, res, next) => {
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) {
      return res.status(400).json({ success: false, message: 'Company context required' });
    }

    const grn = await GoodsReceivedNote.findOne({
      _id: req.params.id,
      company: companyId,
    })
      .populate({
        path: "purchaseOrder",
        populate: {
          path: "lines.product",
          select: "name sku",
        },
      })
      .populate("lines.product", "name sku trackingType")
      .populate("supplier", "name code contact")
      .populate("warehouse", "name code")
      .populate("createdBy", "name email")
      .populate("confirmedBy", "name email")
      .populate("journalEntry")
      .lean();

    if (!grn) {
      return res.status(404).json({ success: false, message: "GRN not found" });
    }

    const confirmedReturns = await PurchaseReturn.find({
      company: companyId,
      grn: grn._id,
      status: "confirmed",
    }).lean();
    const returnedByGrnLine = new Map();
    for (const purchaseReturn of confirmedReturns) {
      for (const line of purchaseReturn.lines || []) {
        const grnLineId = resolveRefId(line.grnLine || line.grnLineId);
        returnedByGrnLine.set(
          grnLineId,
          (returnedByGrnLine.get(grnLineId) || 0) + Number(line.qtyReturned || 0),
        );
      }
    }
    const sourceSerialNumbers = (grn.lines || [])
      .flatMap((line) => Array.isArray(line.serialNumbers) ? line.serialNumbers : [])
      .map((serialNumber) => String(serialNumber).toUpperCase());
    const availableSerials = sourceSerialNumbers.length
      ? await StockSerialNumber.find({
        company: companyId,
        grn: grn._id,
        status: 'in_stock',
        serialNo: { $in: sourceSerialNumbers },
      }).lean()
      : [];
    const availableSerialsByProduct = new Map();
    for (const serial of availableSerials) {
      const productId = resolveRefId(serial.product || serial.productId);
      const serials = availableSerialsByProduct.get(productId) || new Set();
      serials.add(String(serial.serialNo).toUpperCase());
      availableSerialsByProduct.set(productId, serials);
    }
    grn.lines = (grn.lines || []).map((line) => {
      const received = Number(line.qtyReceived) || 0;
      const returned = returnedByGrnLine.get(resolveRefId(line._id || line.id)) || 0;
      const productId = resolveRefId(line.product || line.productId);
      const availableSerialsForProduct = availableSerialsByProduct.get(productId) || new Set();
      return {
        ...line,
        qtyPreviouslyReturned: returned,
        qtyReturnable: Math.max(0, received - returned),
        returnableSerialNumbers: (Array.isArray(line.serialNumbers) ? line.serialNumbers : [])
          .map((serialNumber) => String(serialNumber).toUpperCase())
          .filter((serialNumber) => availableSerialsForProduct.has(serialNumber)),
      };
    });

    // Calculate totals from lines (includes freight when absorbed into unitCost)
    grn.totalAmount = computeGrnTotal(grn);

    res.json({ success: true, data: grn });
  } catch (err) {
    next(err);
  }
};
