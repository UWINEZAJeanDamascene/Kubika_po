const mongoose = require("mongoose");
const GoodsReceivedNote = require("../models/GoodsReceivedNote");
const PurchaseOrder = require("../models/PurchaseOrder");
const InventoryBatch = require("../models/InventoryBatch");
const StockBatch = require("../models/StockBatch");
const StockSerialNumber = require("../models/StockSerialNumber");
const StockMovement = require("../models/StockMovement");
const Product = require("../models/Product");
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
    (sum, line) =>
      sum + Number(line.qtyReceived || 0) * Number(line.unitCost || 0),
    0,
  );
  const freightAmt = Number(grn.freight?.actualAmount) || 0;
  const freightAbsorbed = grn.freight?.includeInInventoryCost;
  if (freightAmt > 0 && !freightAbsorbed) {
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
  for (const line of grnLines || []) {
    const poLine = po.lines.id(line.purchaseOrderLine);
    if (!poLine) continue;
    const remainingQty =
      Number(poLine.qtyOrdered || 0) - Number(poLine.qtyReceived || 0);
    const qtyReceived = Number(line.qtyReceived || 0);
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

    // Validate qtyReceived against remaining qty for each line and enrich with taxRate from PO
    const enrichedLines = [];
    for (const line of lines) {
      const poLine = po.lines.id(line.purchaseOrderLine);
      if (poLine) {
        const remainingQty =
          (poLine.qtyOrdered || 0) - (poLine.qtyReceived || 0);
        if (line.qtyReceived > remainingQty) {
          return res.status(400).json({
            success: false,
            message: `Qty received (${line.qtyReceived}) exceeds remaining qty (${remainingQty}) for product`,
          });
        }
        // Enrich line with taxRate from PO line for frontend display
        let mfgDate = null;
        let expDate = null;
        
        if (line.manufactureDate && typeof line.manufactureDate === 'string' && line.manufactureDate.trim()) {
          const parsed = new Date(line.manufactureDate);
          if (!isNaN(parsed.getTime())) {
            mfgDate = parsed;
          }
        }
        
        if (line.expiryDate && typeof line.expiryDate === 'string' && line.expiryDate.trim()) {
          const parsed = new Date(line.expiryDate);
          if (!isNaN(parsed.getTime())) {
            expDate = parsed;
          }
        }
        
        enrichedLines.push({
          ...line,
          product: resolveLineProductId(line),
          taxRate: line.taxRate != null ? line.taxRate : poLine.taxRate || 0,
          manufactureDate: mfgDate,
          expiryDate: expDate,
        });
      } else {
        enrichedLines.push({
          ...line,
          product: resolveLineProductId(line),
        });
      }
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
      freightPayload = {
        carrier: freight.carrier || (po.freight && po.freight.carrier) || '',
        actualAmount: freight.actualAmount != null ? freight.actualAmount : (po.freight && po.freight.amount) || 0,
        paymentMethod: freight.paymentMethod || (po.freight && po.freight.paymentMethod) || 'on_account',
        account: freight.account || (po.freight && po.freight.account) || '5110',
        includeInInventoryCost: freight.includeInInventoryCost != null ? freight.includeInInventoryCost : (po.freight && po.freight.includeInInventoryCost) || false,
        allocationMethod: freight.allocationMethod || 'by_value',
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
      warehouse,
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

    // First pass: Validate tracking types and prepare batch/serial data
    for (const line of grn.lines) {
      const product = await Product.findOne(
        { _id: line.product, company: companyId },
        null,
        useSession ? { session: sess } : {},
      );

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
        // Update the GRN line unitCost to landed cost for downstream processing
        line.unitCost = Math.round(newUnitCost * 1000000) / 1000000;
      }
    }

    // Second pass: Process stock
    for (const line of grn.lines) {
      const product = await Product.findOne(
        { _id: line.product, company: companyId },
        null,
        useSession ? { session: sess } : {},
      );
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
          stockBatch.qtyOnHand =
            (Number(stockBatch.qtyOnHand) || 0) + Number(line.qtyReceived);
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
            unitCost: line.unitCost,
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
        for (const serialNo of line.serialNumbers) {
          // Check if serial already exists for this product
          const existingSerial = await StockSerialNumber.findOne(
            {
              company: companyId,
              product: line.product,
              serialNo: serialNo.toUpperCase(),
            },
            null,
            useSession ? { session: sess } : {},
          );

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
            unitCost: line.unitCost,
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
        unitCost: line.unitCost,
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
      const receivedValue = Number(line.unitCost) * Number(line.qtyReceived);
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
        const recvCost = Number(line.unitCost);
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
        // StockLevel sync is best-effort — do not abort the GRN confirmation
        console.error("StockLevel sync failed for GRN line:", slErr.message);
      }

      const movement = new StockMovement({
        company: companyId,
        product: line.product,
        type: "in",
        reason: "purchase",
        quantity: line.qtyReceived,
        previousStock,
        newStock: product.currentStock,
        unitCost: line.unitCost,
        totalCost: line.unitCost * line.qtyReceived,
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
      productTotals.set(String(line.product), prev + lineNet);
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

    // Liquidate encumbrances if PO is fully received
    if (wasFullyReceived) {
      try {
        const BudgetService = require('../services/budgetService');
        for (const line of po.lines) {
          if (line.encumbrance_id) {
            try {
              await BudgetService.liquidateEncumbrance(
                companyId,
                'purchase_order',
                po._id.toString(),
                {
                  document_type: 'goods_received_note',
                  document_id: grn._id.toString(),
                  document_number: grn.referenceNo,
                  amount: parseFloat(line.lineTotal?.toString() || 0),
                  notes: `GRN confirmed - PO fully received`
                },
                req.user.id
              );
              console.log(`[GRN] Liquidated encumbrance ${line.encumbrance_id} for PO line`);
            } catch (liqErr) {
              console.error('Error liquidating encumbrance:', liqErr);
            }
          }
        }
      } catch (encErr) {
        console.error('Error processing encumbrance liquidation:', encErr);
      }
    }

    // Use TaxAutomationService for centralized tax computation
    const purchaseTax = await TaxAutomationService.computePurchaseTax(
      companyId,
      purchaseTaxLines,
    );

    // Build journal lines from TaxAutomationService output
    // Inventory lines (per product)
    for (const [prodId, amt] of productTotals.entries()) {
      const product = await Product.findById(prodId).lean();
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

    const creditTotal = purchaseTax.totals.gross + (freightAmount > 0 && !includeFreightInCost ? freightAmount : 0);
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

    // Calculate and set totalAmount from lines (includes freight when absorbed into unitCost)
    const grnTotal = grn.lines.reduce(
      (sum, line) =>
        sum + Number(line.qtyReceived) * Number(line.unitCost || 0),
      0,
    );
    // Ensure total includes freight even when not absorbed (separate line scenario)
    const totalWithFreight = grnTotal + (includeFreightInCost ? 0 : freightAmount);
    grn.totalAmount = totalWithFreight;
    grn.balance = totalWithFreight;
    grn.paymentStatus = "pending";

    await grn.save(useSession ? { session: sess } : {});

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
      page = 1,
      limit = 20,
    } = req.query;

    const query = { company: companyId };

    if (supplier_id) query.supplier = supplier_id;
    if (status) query.status = status;
    if (ebmStatus) query["ebm.ebmStatus"] = ebmStatus;
    if (date_from || date_to) {
      query.receivedDate = {};
      if (date_from) query.receivedDate.$gte = new Date(date_from);
      if (date_to) query.receivedDate.$lte = new Date(date_to);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const grns = await GoodsReceivedNote.find(query)
      .populate("purchaseOrder", "referenceNo")
      .populate("supplier", "name code")
      .populate("warehouse", "name code")
      .populate("lines.product", "name sku")
      .populate("createdBy", "name email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
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
    if (receivedDate !== undefined) grn.receivedDate = receivedDate;
    if (freight !== undefined) {
      grn.freight = {
        ...grn.freight,
        ...freight,
      };
    }

    if (lines && Array.isArray(lines)) {
      grn.lines = [];
      for (const line of lines) {
        grn.lines.push({
          product: resolveLineProductId(line),
          qtyReceived: line.qtyReceived,
          unitCost: line.unitCost,
          taxRate: line.taxRate || 0,
          purchaseOrderLine: line.purchaseOrderLine,
          batchNo: line.batchNo,
          serialNumbers: line.serialNumbers,
          manufactureDate: line.manufactureDate,
          expiryDate: line.expiryDate,
        });
      }
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

    // Calculate totals from lines (includes freight when absorbed into unitCost)
    grn.totalAmount = computeGrnTotal(grn);

    res.json({ success: true, data: grn });
  } catch (err) {
    next(err);
  }
};
