const Product = require('../models/Product');
const PurchaseOrder = require('../models/PurchaseOrder');
const Purchase = require('../models/Purchase');
const Supplier = require('../models/Supplier');
const StockLevel = require('../models/StockLevel');
const StockMovement = require('../models/StockMovement');
const SystemSettings = require('../models/SystemSettings');
const { Prisma } = require('@prisma/client');
const { dbClient } = require('../lib/prisma');
const {
  notifyAutoPurchaseOrderCreated,
  notifyAutoDirectPurchaseCreated
} = require('./notificationHelper');

function toNumber(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value.toString) {
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toObjectId(value) {
  return value ? String(value) : null;
}

function shouldCheckMovement(movement) {
  if (!movement || movement.__skipAutoReorder) return false;
  if (!movement.product && !movement.product_id) return false;
  if (!movement.company && !movement.company_id) return false;

  if (movement.type === 'out') return true;
  if (movement.type === 'adjustment') return true;

  const reorderReasons = new Set([
    'sale',
    'damage',
    'loss',
    'theft',
    'expired',
    'correction',
    'audit_shortage',
    'dispatch',
    'transfer_out'
  ]);
  return reorderReasons.has(movement.reason);
}

class AutoPurchaseOrderService {
  static async handleStockMovementSaved(movement) {
    if (!shouldCheckMovement(movement)) return null;

    try {
      return await this.checkAndCreateForItem({
        companyId: movement.company || movement.company_id,
        productId: movement.product || movement.product_id,
        performedBy: movement.performedBy || null
      });
    } catch (error) {
      console.error('[AutoPO] Reorder check failed:', error.message);
      return null;
    }
  }

  static async getCurrentStock(companyId, productId) {
    const companyObjectId = toObjectId(companyId);
    const productObjectId = toObjectId(productId);

    const totals = await dbClient().stockLevel.groupBy({
      by: ['productId'],
      where: { companyId: companyObjectId, productId: productObjectId },
      _sum: { qtyOnHand: true },
    });

    if (totals.length > 0) {
      return toNumber(totals[0]._sum?.qtyOnHand);
    }

    const product = await dbClient().product.findFirst({
      where: { id: productObjectId, companyId: companyObjectId },
      select: { currentStock: true },
    });
    return toNumber(product?.currentStock);
  }

  static async getLastPurchaseCost(companyId, productId, product) {
    const latestPurchase = await StockMovement.findOne({
      $and: [
        { $or: [{ company: companyId }, { company_id: companyId }] },
        { $or: [{ product: productId }, { product_id: productId }] }
      ],
      type: 'in',
      reason: 'purchase'
    })
      .sort({ movementDate: -1, createdAt: -1 })
      .select('unitCost')
      .lean();

    const latestCost = toNumber(latestPurchase?.unitCost);
    if (latestCost > 0) return latestCost;

    const averageCost = toNumber(product.averageCost);
    if (averageCost > 0) return averageCost;

    return toNumber(product.costPrice);
  }

  static async getSettings(companyId) {
    return SystemSettings.findOneAndUpdate(
      { company_id: companyId },
      { $setOnInsert: { company_id: companyId } },
      { upsert: true, new: true, lean: true }
    );
  }

  static async getSalesVelocity(companyId, productId, lookbackDays) {
    const since = new Date(Date.now() - (Number(lookbackDays) || 90) * 24 * 60 * 60 * 1000);
    const [row] = await dbClient().$queryRaw(Prisma.sql`
      SELECT COALESCE(SUM(quantity), 0) AS quantity,
             COUNT(DISTINCT DATE(movement_date))::int AS "salesDays"
      FROM stock_movements
      WHERE company_id = ${toObjectId(companyId)} AND product_id = ${toObjectId(productId)}
        AND type = 'out' AND reason IN ('sale', 'dispatch') AND movement_date >= ${since}
    `);
    const totalSold = toNumber(row?.quantity);
    const observedDays = Math.max(1, Math.ceil((Date.now() - since.getTime()) / (24 * 60 * 60 * 1000)));
    return {
      totalSold,
      averageDailyDemand: totalSold / observedDays,
      salesDays: Number(row?.salesDays || 0),
      lookbackDays: observedDays
    };
  }

  static calculateReorderPlan({ product, supplier, currentStock, settings }) {
    const leadTimeDays = Math.max(0, toNumber(supplier?.leadTime));
    const safetyStockDays = Math.max(0, toNumber(settings.auto_reorder_safety_stock_days));
    const configuredReorderPoint = toNumber(product.reorderPoint) || toNumber(product.lowStockThreshold);
    const configuredReorderQty = toNumber(product.reorderQuantity);

    return this.getSalesVelocity(toObjectId(product.company), toObjectId(product._id), settings.auto_reorder_sales_lookback_days)
      .then((velocity) => {
        const predictedReorderPoint = Math.ceil(velocity.averageDailyDemand * (leadTimeDays + safetyStockDays));
        const effectiveReorderPoint = Math.max(configuredReorderPoint, predictedReorderPoint);
        const daysUntilStockout = velocity.averageDailyDemand > 0 ? currentStock / velocity.averageDailyDemand : null;
        const suggestedQty = configuredReorderQty > 0
          ? configuredReorderQty
          : Math.max(Math.ceil(effectiveReorderPoint * 2 - currentStock), Math.ceil(velocity.averageDailyDemand * 30), 1);

        return {
          currentStock,
          configuredReorderPoint,
          predictedReorderPoint,
          effectiveReorderPoint,
          suggestedQty,
          leadTimeDays,
          safetyStockDays,
          averageDailyDemand: Number(velocity.averageDailyDemand.toFixed(4)),
          totalSoldInLookback: velocity.totalSold,
          salesLookbackDays: velocity.lookbackDays,
          daysUntilStockout: daysUntilStockout == null ? null : Number(daysUntilStockout.toFixed(2)),
          needsReorder: currentStock <= effectiveReorderPoint
        };
      });
  }

  static async decideProcurementFlow({ companyId, product, supplier, reorderQty, unitCost, settings, performedBy }) {
    const estimatedTotal = reorderQty * unitCost;
    const directThreshold = toNumber(settings.auto_reorder_direct_purchase_threshold);
    const hasDirectUser = Boolean(performedBy || settings.auto_reorder_created_by);
    const cashTerms = !supplier?.paymentTerms || supplier.paymentTerms === 'cash';
    const belowThreshold = directThreshold === 0 || estimatedTotal <= directThreshold;
    const poApprovalRequired = settings.require_po_approval === true &&
      (toNumber(settings.po_approval_threshold) === 0 || estimatedTotal >= toNumber(settings.po_approval_threshold));

    if (cashTerms && belowThreshold && !poApprovalRequired && hasDirectUser) {
      return {
        flow: 'direct_purchase',
        reason: 'Supplier uses cash terms, amount is inside the configured direct purchase threshold, and PO approval is not required.',
        estimatedTotal
      };
    }

    return {
      flow: 'purchase_order',
      reason: poApprovalRequired
        ? 'PO approval is required by procurement settings.'
        : !hasDirectUser
          ? 'No auto-reorder user is configured for direct purchase creation.'
          : !cashTerms
            ? 'Supplier payment terms require a purchase order workflow.'
            : 'Amount exceeds the configured direct purchase threshold.',
      estimatedTotal
    };
  }

  static async findExistingAutoDocument(companyId, productId) {
    const [purchaseOrder, purchase] = await Promise.all([
      PurchaseOrder.findOne({
        company: companyId,
        source: 'AUTO',
        status: { $in: ['draft', 'approved', 'partially_received'] },
        autoReorderProduct: productId,
        'lines.product': productId
      }).lean(),
      Purchase.findOne({
        company: companyId,
        status: { $in: ['draft', 'ordered', 'partial'] },
        notes: /Auto reorder/,
        'items.product': productId
      }).lean()
    ]);
    if (purchaseOrder) return { type: 'purchase_order', document: purchaseOrder };
    if (purchase) return { type: 'direct_purchase', document: purchase };
    return null;
  }

  static async createDirectPurchase({ companyId, product, supplier, reorderQty, unitCost, performedBy, settings, plan }) {
    const subtotal = reorderQty * unitCost;
    const quantity = Number(reorderQty) || 0;
    const cost = Number(unitCost) || 0;
    const total = Number(subtotal) || 0;
    const purchase = await Purchase.create({
      company: companyId,
      supplier: supplier._id,
      supplierTin: supplier.taxId,
      supplierName: supplier.name,
      supplierAddress: supplier.contact?.address,
      warehouse: product.defaultWarehouse || undefined,
      status: 'draft',
      paymentTerms: supplier.paymentTerms || 'cash',
      currency: product.currencyCode || 'FRW',
      createdBy: performedBy || settings.auto_reorder_created_by,
      notes: `Auto reorder direct purchase for ${product.name}. Current stock ${plan.currentStock}, reorder point ${plan.effectiveReorderPoint}.`,
      items: [{
        product: product._id,
        itemCode: product.sku,
        description: product.name,
        quantity,
        unit: product.unit,
        unitCost: cost,
        taxCode: product.taxCode || 'A',
        taxRate: product.taxRate || 0,
        subtotal: total,
        totalWithTax: total,
        warehouse: product.defaultWarehouse || undefined
      }]
    });
    return purchase;
  }

  static async createPurchaseOrder({ companyId, product, supplier, reorderQty, unitCost, performedBy, plan }) {
    return PurchaseOrder.create({
      company: companyId,
      supplier: supplier._id,
      warehouse: product.defaultWarehouse || undefined,
      status: 'draft',
      source: 'AUTO',
      autoReorderProduct: product._id,
      orderDate: new Date(),
      createdBy: performedBy || undefined,
      notes: `Auto reorder draft for ${product.name}. Current stock ${plan.currentStock}, reorder point ${plan.effectiveReorderPoint}.`,
      lines: [{
        product: product._id,
        qtyOrdered: reorderQty,
        unitCost,
        taxRate: 0
      }]
    });
  }

  static async analyzeItem({ companyId, productId }) {
    const companyObjectId = toObjectId(companyId);
    const productObjectId = toObjectId(productId);

    const product = await Product.findOne({
      _id: productObjectId,
      company: companyObjectId,
      isArchived: { $ne: true },
      isActive: { $ne: false }
    }).lean();

    if (!product || product.isStockable === false) return null;

    const settings = await this.getSettings(companyObjectId);
    if (settings.auto_reorder_enabled === false) return { product, enabled: false, needsReorder: false };

    const currentStock = await this.getCurrentStock(companyObjectId, productObjectId);
    const preferredSupplierId = product.preferredSupplier || product.preferredSupplierId || product.supplier;
    if (!preferredSupplierId) {
      return {
        product,
        enabled: true,
        needsReorder: false,
        blocked: true,
        reason: 'No preferred supplier is set for this product.'
      };
    }
    const supplier = await Supplier.findOne({ _id: preferredSupplierId, company: companyObjectId }).lean();
    if (!supplier) return { product, enabled: true, needsReorder: false, blocked: true, reason: 'Preferred supplier was not found in this tenant.' };

    const productForPlan = { ...product, company: companyObjectId };
    const plan = await this.calculateReorderPlan({ product: productForPlan, supplier, currentStock, settings });
    const unitCost = await this.getLastPurchaseCost(companyObjectId, productObjectId, product);
    const decision = await this.decideProcurementFlow({
      companyId: companyObjectId,
      product,
      supplier,
      reorderQty: plan.suggestedQty,
      unitCost,
      settings,
      performedBy: null
    });
    const existing = await this.findExistingAutoDocument(companyObjectId, productObjectId);

    return {
      product,
      supplier,
      settings,
      plan,
      decision,
      unitCost,
      existing,
      enabled: true,
      needsReorder: plan.needsReorder,
      blocked: false
    };
  }

  static async checkAndCreateForItem({ companyId, productId, performedBy = null, force = false }) {
    const companyObjectId = toObjectId(companyId);
    const productObjectId = toObjectId(productId);

    const analysis = await this.analyzeItem({ companyId: companyObjectId, productId: productObjectId });
    if (!analysis || analysis.enabled === false || analysis.blocked) return analysis;
    if (!analysis.needsReorder && !force) return analysis;
    if (analysis.settings.auto_reorder_create_documents === false && !force) return analysis;

    const existing = await this.findExistingAutoDocument(companyObjectId, productObjectId);
    if (existing) return { ...analysis, created: false, existing };

    const decision = await this.decideProcurementFlow({
      companyId: companyObjectId,
      product: analysis.product,
      supplier: analysis.supplier,
      reorderQty: analysis.plan.suggestedQty,
      unitCost: analysis.unitCost,
      settings: analysis.settings,
      performedBy
    });

    const document = decision.flow === 'direct_purchase'
      ? await this.createDirectPurchase({
        companyId: companyObjectId,
        product: analysis.product,
        supplier: analysis.supplier,
        reorderQty: analysis.plan.suggestedQty,
        unitCost: analysis.unitCost,
        performedBy,
        settings: analysis.settings,
        plan: analysis.plan
      })
      : await this.createPurchaseOrder({
        companyId: companyObjectId,
        product: analysis.product,
        supplier: analysis.supplier,
        reorderQty: analysis.plan.suggestedQty,
        unitCost: analysis.unitCost,
        performedBy,
        plan: analysis.plan
      });

    if (decision.flow === 'purchase_order') {
      await notifyAutoPurchaseOrderCreated(companyObjectId, analysis.product, document, analysis.plan.currentStock);
    } else {
      await notifyAutoDirectPurchaseCreated(companyObjectId, analysis.product, document, analysis.plan.currentStock);
    }
    return { ...analysis, decision, created: true, documentType: decision.flow, document };
  }
}

module.exports = AutoPurchaseOrderService;
