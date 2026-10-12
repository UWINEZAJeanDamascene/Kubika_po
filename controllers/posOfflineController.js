'use strict';

const { randomBytes } = require('crypto');
const Product = require('../models/Product');
const StockLevel = require('../models/StockLevel');
const StockSerialNumber = require('../models/StockSerialNumber');
const StockMovement = require('../models/StockMovement');
const TillSession = require('../models/TillSession');
const Warehouse = require('../models/Warehouse');
const SystemSettings = require('../models/SystemSettings');
const AuditLogService = require('../services/AuditLogService');
const { findClaimedRegister } = require('../services/posRegisterService');
const { runInTransaction } = require('../services/transactionService');
const { dbClient } = require('../lib/prisma');
const { issueCapability } = require('../services/posOfflineCapabilityService');
const { getWarehousePriceListPrices, effectivePrice } = require('../services/priceListService');
const { getWarehouseTransferVisibility } = require('../services/posTransferVisibilityService');

const id = () => randomBytes(12).toString('hex');
const userIdOf = (req) => String(req.user?.id || req.user?._id || '');
const companyIdOf = (req) => String(req.user?.company?._id || req.user?.company?.id || '');
const number = (value) => {
  if (value == null) return 0;
  const converted = Number(value.toString ? value.toString() : value);
  return Number.isFinite(converted) ? converted : 0;
};
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const resolveSnapshotTaxRate = (product) => {
  const configured = number(product.taxRate);
  if (configured > 0) return configured;
  const taxCode = String(product.taxCode || '').trim().toUpperCase();
  return taxCode === 'B' ? 18 : 0;
};

exports.issueSnapshot = async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const userId = userIdOf(req);
    const deviceId = String(req.body?.deviceId || '').trim();
    const registerId = String(req.body?.registerId || '').trim();
    const warehouseId = String(req.body?.warehouseId || '').trim();
    if (!deviceId || deviceId.length > 160 || !registerId || !warehouseId) {
      return res.status(400).json({ success: false, code: 'POS_OFFLINE_SNAPSHOT_BINDING_INVALID', message: 'A device, assigned register, and warehouse are required.' });
    }
    const settings = await SystemSettings.findOne({ company: companyId }).lean();
    if (!settings?.posOfflineEnabled) {
      return res.status(403).json({ success: false, code: 'POS_OFFLINE_DISABLED', message: 'Offline POS is disabled for this company.' });
    }
    const claimedRegister = await findClaimedRegister(companyId, registerId, deviceId);
    if (!claimedRegister) {
      return res.status(403).json({ success: false, code: 'POS_REGISTER_CLAIM_REQUIRED', message: 'This device is not assigned to the requested POS register.' });
    }
    const [warehouse, till] = await Promise.all([
      Warehouse.findOne({ _id: warehouseId, company: companyId, isActive: { $ne: false } }).lean(),
      TillSession.findOne({
        company: companyId,
        openedBy: userId,
        registerId: claimedRegister.code,
        status: 'open',
      }).lean(),
    ]);
    if (!warehouse || !till) {
      return res.status(409).json({ success: false, code: 'POS_OFFLINE_CONTEXT_UNAVAILABLE', message: 'An active warehouse and an open till for this cashier are required to create an offline snapshot.' });
    }

    const products = await Product.find({ company: companyId, isActive: true })
      .select('_id name sku sellingPrice unit taxRate taxCode isStockable trackingType trackSerialNumbers trackBatch averageCost')
      .lean();
    if (products.length > 5000) {
      return res.status(413).json({ success: false, code: 'POS_OFFLINE_CATALOG_TOO_LARGE', message: 'The active catalog exceeds the safe offline snapshot limit. Reduce the catalog or use POS online.' });
    }
    const productIds = products.map((product) => product._id);
    const [stockRows, serialRows, promotionRows, priceListPricing, transferVisibility] = await Promise.all([
      StockLevel.find({
        company_id: companyId,
        warehouse_id: warehouseId,
        product_id: { $in: productIds },
      }).lean(),
      StockSerialNumber.find({
        company: companyId,
        warehouse: warehouseId,
        status: { $in: ['in_stock', 'returned'] },
      }).select('product serialNo').limit(20001).lean(),
      dbClient().$queryRawUnsafe(
        'SELECT id, name, code, discount_type AS "discountType", value, starts_at AS "startsAt", ends_at AS "endsAt" FROM pos_promotions WHERE company_id = $1 AND is_active = TRUE AND starts_at <= CURRENT_TIMESTAMP AND ends_at > CURRENT_TIMESTAMP',
        companyId,
      ),
      getWarehousePriceListPrices(companyId, warehouseId, productIds),
      getWarehouseTransferVisibility(companyId, warehouseId, productIds),
    ]);
    if (serialRows.length > 20000) {
      return res.status(413).json({ success: false, code: 'POS_OFFLINE_SERIAL_CATALOG_TOO_LARGE', message: 'This warehouse has too many available serial numbers for a safe offline snapshot. Use POS online for serialized products.' });
    }
    const stockByProduct = new Map(stockRows.map((row) => [String(row.product_id), row]));
    const serialsByProduct = new Map();
    for (const serial of serialRows) {
      const key = String(serial.product);
      const values = serialsByProduct.get(key) || [];
      values.push(String(serial.serialNo).trim().toUpperCase());
      serialsByProduct.set(key, values);
    }
    const productSnapshots = Object.fromEntries(products.map((product) => {
      const productId = String(product._id);
      const stock = stockByProduct.get(productId);
      const trackingType = product.trackingType === 'serial' || product.trackSerialNumbers
        ? 'serial'
        : product.trackingType === 'batch' || product.trackBatch
          ? 'batch'
          : (product.trackingType || 'none');
      return [productId, {
        name: product.name,
        sku: product.sku || '',
        unit: product.unit || 'pcs',
        standardPrice: number(product.sellingPrice),
        price: effectivePrice(productId, number(product.sellingPrice), priceListPricing.priceByProduct),
        taxRate: resolveSnapshotTaxRate(product),
        taxCode: product.taxCode || (number(product.taxRate) > 0 ? 'B' : 'A'),
        isStockable: product.isStockable !== false,
        trackingType,
        averageCost: number(product.averageCost),
        availableStock: Math.max(0, number(stock?.qty_on_hand) - number(stock?.qty_reserved)),
        serialNumbers: serialsByProduct.get(productId) || [],
        incomingTransfers: transferVisibility[productId]?.incoming || [],
        outgoingTransfers: transferVisibility[productId]?.outgoing || [],
      }];
    }));
    const issuedAt = Date.now();
    const maxHours = Math.max(1, Math.min(720, Number(settings.posOfflineMaxHours) || 24));
    const expiresAt = issuedAt + maxHours * 60 * 60 * 1000;
    const snapshotId = id();
    const snapshotData = {
      products: productSnapshots,
      transfersByProduct: transferVisibility,
      priceListId: priceListPricing.priceListId,
      promotions: promotionRows.map((promotion) => ({
        id: String(promotion.id),
        name: promotion.name,
        code: promotion.code,
        discountType: promotion.discountType,
        value: number(promotion.value),
        startsAt: new Date(promotion.startsAt).toISOString(),
        endsAt: new Date(promotion.endsAt).toISOString(),
      })),
      negativeStockAllowed: Boolean(settings.allowNegativeStock),
      escalationDays: Math.max(1, Math.min(365, Number(settings.posNegativeStockEscalationDays) || 3)),
      maxHours,
    };
    const queueLimit = Math.max(1, number(settings.posOfflineQueueLimit) || 1_000_000);
    await dbClient().$executeRawUnsafe(
      'INSERT INTO pos_offline_snapshots (id, company_id, user_id, device_id, register_id, warehouse_id, till_session_id, snapshot_data, queue_limit, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::numeric, $10::timestamptz, $11::timestamptz)',
      snapshotId, companyId, userId, deviceId, registerId, warehouseId, String(till._id),
      JSON.stringify(snapshotData), queueLimit, new Date(issuedAt), new Date(expiresAt),
    );
    const capability = issueCapability({
      id: snapshotId,
      companyId,
      userId,
      deviceId,
      registerId,
      warehouseId,
      tillSessionId: String(till._id),
      issuedAt,
      expiresAt,
    });
    res.status(200).json({
      success: true,
      data: {
        capability,
        issuedAt: new Date(issuedAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        queueLimit,
        maxHours,
        productCount: products.length,
        serialNumbersByProduct: Object.fromEntries([...serialsByProduct.entries()]),
        transfersByProduct: transferVisibility,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.listConflicts = async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    await dbClient().$executeRawUnsafe(
      "UPDATE pos_offline_conflicts SET status = 'escalated', updated_at = CURRENT_TIMESTAMP WHERE company_id = $1 AND status = 'open' AND escalation_at <= CURRENT_TIMESTAMP",
      companyId,
    );
    const conflicts = await dbClient().$queryRawUnsafe(
      `SELECT c.id, c.offline_sale_id AS "offlineSaleId", c.invoice_id AS "invoiceId", i.reference_no AS "invoiceNumber", c.product_id AS "productId", p.name AS "productName", c.warehouse_id AS "warehouseId", c.conflict_type AS "conflictType", c.details, c.status, c.escalation_at AS "escalationAt", c.created_at AS "createdAt" FROM pos_offline_conflicts c LEFT JOIN invoices i ON i.id = c.invoice_id AND i.company_id = c.company_id LEFT JOIN products p ON p.id = c.product_id AND p.company_id = c.company_id WHERE c.company_id = $1 AND c.status IN ('open', 'escalated') ORDER BY c.escalation_at ASC, c.created_at ASC LIMIT 500`,
      companyId,
    );
    res.status(200).json({ success: true, data: conflicts });
  } catch (error) {
    next(error);
  }
};

exports.resolveConflict = async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const userId = userIdOf(req);
    const conflictId = String(req.params.conflictId || '');
    const resolution = String(req.body?.resolution || '');
    const reason = String(req.body?.reason || '').trim();
    const evidenceReference = String(req.body?.evidenceReference || '').trim();
    const allowed = new Set(['record_missing_receipt', 'stock_adjustment_recorded', 'confirm_shortage', 'assign_serials']);
    if (!allowed.has(resolution) || reason.length < 10 || reason.length > 1000) {
      return res.status(400).json({ success: false, code: 'POS_OFFLINE_RESOLUTION_INVALID', message: 'Select a supported resolution and provide a reason of 10–1000 characters.' });
    }

    const result = await runInTransaction(async () => {
      const rows = await dbClient().$queryRawUnsafe(
        'SELECT id, offline_sale_id AS "offlineSaleId", invoice_id AS "invoiceId", product_id AS "productId", warehouse_id AS "warehouseId", conflict_type AS "conflictType", details, status, created_at AS "createdAt" FROM pos_offline_conflicts WHERE id = $1 AND company_id = $2 FOR UPDATE',
        conflictId, companyId,
      );
      const conflict = rows[0];
      if (!conflict) throw fail(404, 'POS_OFFLINE_CONFLICT_NOT_FOUND', 'Offline POS conflict was not found.');
      if (!['open', 'escalated'].includes(conflict.status)) throw fail(409, 'POS_OFFLINE_CONFLICT_RESOLVED', 'This offline POS conflict has already been resolved.');
      if (conflict.conflictType === 'serial' && resolution !== 'assign_serials') {
        throw fail(400, 'POS_OFFLINE_RESOLUTION_INVALID', 'Serial conflicts must be resolved by assigning available serial numbers.');
      }
      if (conflict.conflictType === 'stock' && resolution === 'assign_serials') {
        throw fail(400, 'POS_OFFLINE_RESOLUTION_INVALID', 'Serial assignment is only valid for serial conflicts.');
      }

      let serials = [];
      if (resolution === 'assign_serials') {
        if (conflict.conflictType !== 'serial') throw fail(400, 'POS_OFFLINE_RESOLUTION_INVALID', 'Serial assignment is only valid for serial conflicts.');
        serials = Array.isArray(req.body?.serialNumbers)
          ? req.body.serialNumbers.map((value) => String(value).trim().toUpperCase()).filter(Boolean)
          : [];
        const quantity = Number(conflict.details?.quantity) || 0;
        if (serials.length !== quantity || new Set(serials).size !== serials.length) {
          throw fail(400, 'POS_OFFLINE_SERIAL_ASSIGNMENT_INVALID', `Assign exactly ${quantity} unique serial number(s).`);
        }
        const available = await StockSerialNumber.find({
          company: companyId,
          product: conflict.productId,
          warehouse: conflict.warehouseId,
          serialNo: { $in: serials },
          status: { $in: ['in_stock', 'returned'] },
        }).select('_id serialNo').lean();
        if (available.length !== serials.length) throw fail(409, 'POS_OFFLINE_SERIAL_ASSIGNMENT_UNAVAILABLE', 'One or more serial numbers are no longer available in this warehouse.');
        const updated = await StockSerialNumber.updateMany({
          company: companyId,
          product: conflict.productId,
          warehouse: conflict.warehouseId,
          serialNo: { $in: serials },
          status: { $in: ['in_stock', 'returned'] },
        }, { $set: { status: 'dispatched', dispatchedVia: conflict.invoiceId, dispatchedAt: new Date() } });
        if (updated.modifiedCount !== serials.length) throw fail(409, 'POS_OFFLINE_SERIAL_ASSIGNMENT_UNAVAILABLE', 'Serial availability changed while resolving the conflict.');
        await StockMovement.updateMany({
          company: companyId,
          product: conflict.productId,
          warehouse: conflict.warehouseId,
          referenceDocument: conflict.invoiceId,
          reason: 'sale',
        }, { $set: { serialNumbers: serials } });
      } else if (['record_missing_receipt', 'stock_adjustment_recorded'].includes(resolution)) {
        if (evidenceReference.length < 4 || evidenceReference.length > 120) {
          throw fail(400, 'POS_OFFLINE_EVIDENCE_REQUIRED', 'Enter the posted receipt or stock-adjustment reference before resolving this conflict.');
        }
        const movement = await StockMovement.findOne({
          company: companyId,
          product: conflict.productId,
          warehouse: conflict.warehouseId,
          referenceNumber: evidenceReference,
          type: 'in',
          movementDate: { $gte: new Date(conflict.createdAt) },
        }).lean();
        if (!movement) throw fail(409, 'POS_OFFLINE_EVIDENCE_NOT_FOUND', 'No matching posted inbound stock movement was found for this product and warehouse. Post the receipt or adjustment first.');
      } else if (conflict.conflictType === 'serial') {
        throw fail(400, 'POS_OFFLINE_RESOLUTION_INVALID', 'Serial conflicts must be resolved by assigning available serial numbers.');
      }

      const updated = await dbClient().$executeRawUnsafe(
        "UPDATE pos_offline_conflicts SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, resolved_by_id = $1, resolution = $2, resolution_reason = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4 AND company_id = $5 AND status IN ('open', 'escalated')",
        userId, resolution, JSON.stringify({ reason, evidenceReference: evidenceReference || null, serialNumbers: serials }),
        conflictId, companyId,
      );
      if (updated !== 1) throw fail(409, 'POS_OFFLINE_CONFLICT_RESOLVED', 'This offline POS conflict was resolved by another manager.');
      return { conflict, resolution };
    });

    await AuditLogService.log({
      companyId,
      userId,
      action: 'pos_offline_conflict.resolve',
      entityType: 'pos_offline_conflict',
      entityId: conflictId,
      changes: { resolution: result.resolution, reason, evidenceReference: evidenceReference || null },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.status(200).json({ success: true, message: 'Offline POS conflict resolved and audited.' });
  } catch (error) {
    next(error);
  }
};
