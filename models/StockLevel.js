/**
 * StockLevel — PostgreSQL (Prisma) backed.
 * Preserves snake_case API fields and static helpers for GRN/transfers.
 */

const mongoose = require('mongoose');
const { prisma } = require('../lib/prisma');
const { makeCompatModel, translateFilter, translateSort, IMPOSSIBLE, toId } = require('../utils/prismaCompat');
const { getCompanyId } = require('../utils/prismaTenant');
const { decimalToNumber } = require('../utils/decimalHelpers');
const {
  stockLevelToApi,
  stockLevelTranslateCreate,
  stockLevelTranslateUpdate,
} = require('../utils/inventoryJournalMappers');

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  company_id: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  product_id: { target: 'productId', isId: true },
  productId: { target: 'productId', isId: true },
  warehouse_id: { target: 'warehouseId', isId: true },
  warehouseId: { target: 'warehouseId', isId: true },
  qty_on_hand: { target: 'qtyOnHand' },
  qty_reserved: { target: 'qtyReserved' },
  qty_on_order: { target: 'qtyOnOrder' },
  avg_cost: { target: 'avgCost' },
  total_value: { target: 'totalValue' },
  last_movement_at: { target: 'lastMovementAt' },
  last_movement_type: { target: 'lastMovementType' },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

if (!mongoose.models.StockLevel) {
  mongoose.model('StockLevel', new mongoose.Schema({}, { strict: false, collection: 'stocklevels' }));
}

function applyTenant(where, opts = {}) {
  if (where === IMPOSSIBLE) return where;
  if (opts.skipTenant) return where;
  if (where && where.companyId !== undefined) return where;
  const companyId = opts.companyId || getCompanyId();
  if (!companyId) return where;
  return { ...where, companyId: String(companyId) };
}

function wrapStockLevelDoc(apiDoc) {
  if (!apiDoc || apiDoc.__mutable) return apiDoc;
  const doc = { ...apiDoc, __mutable: true };

  doc.toObject = () => {
    const o = { ...doc };
    ['save', 'toObject', 'toJSON', 'lean', '__mutable', 'applyMovement', 'reserve', 'releaseReservation', 'addOnOrder', 'reduceOnOrder'].forEach((k) => delete o[k]);
    return o;
  };
  doc.lean = () => doc.toObject();
  doc.toJSON = () => doc.toObject();

  doc.save = async function save() {
    const payload = stockLevelTranslateUpdate({ $set: doc });
    const row = await prisma.stockLevel.update({
      where: { id: String(doc._id) },
      data: payload,
    });
    const next = stockLevelToApi(row);
    Object.keys(doc).forEach((k) => delete doc[k]);
    Object.assign(doc, wrapStockLevelDoc(next));
    return doc;
  };

  doc.applyMovement = function applyMovement(movementType, qty, unitCost = null) {
    const increase = ['receipt', 'transfer_in', 'adjustment_positive', 'return_in'];
    const decrease = ['dispatch', 'transfer_out', 'adjustment_negative', 'return_out'];
    if (increase.includes(movementType)) {
      doc.qty_on_hand = Math.round((doc.qty_on_hand + qty) * 10000) / 10000;
    } else if (decrease.includes(movementType)) {
      doc.qty_on_hand = Math.round((doc.qty_on_hand - qty) * 10000) / 10000;
      if (doc.qty_on_hand < 0) {
        throw new Error(`STOCK_NEGATIVE: Movement would result in negative stock. Current: ${doc.qty_on_hand + qty}, Removing: ${qty}`);
      }
    } else {
      throw new Error(`UNKNOWN_MOVEMENT_TYPE: ${movementType}`);
    }
    doc.total_value = Math.round(doc.qty_on_hand * doc.avg_cost * 100) / 100;
    doc.qty_available = Math.max(0, doc.qty_on_hand - doc.qty_reserved);
    doc.last_movement_at = new Date();
    doc.last_movement_type = movementType;
    return doc;
  };

  doc.reserve = function reserve(qty) {
    const available = doc.qty_on_hand - doc.qty_reserved;
    if (available < qty) {
      throw new Error(`INSUFFICIENT_STOCK: Cannot reserve ${qty}. Available: ${Math.round(available * 10000) / 10000}`);
    }
    doc.qty_reserved = Math.round((doc.qty_reserved + qty) * 10000) / 10000;
    doc.qty_available = Math.max(0, doc.qty_on_hand - doc.qty_reserved);
    return doc;
  };

  doc.releaseReservation = function releaseReservation(qty) {
    doc.qty_reserved = Math.round(Math.max(0, doc.qty_reserved - qty) * 10000) / 10000;
    doc.qty_available = Math.max(0, doc.qty_on_hand - doc.qty_reserved);
    return doc;
  };

  doc.addOnOrder = function addOnOrder(qty) {
    doc.qty_on_order = Math.round((doc.qty_on_order + qty) * 10000) / 10000;
    return doc;
  };

  doc.reduceOnOrder = function reduceOnOrder(qty) {
    doc.qty_on_order = Math.round(Math.max(0, doc.qty_on_order - qty) * 10000) / 10000;
    return doc;
  };

  return doc;
}

const model = makeCompatModel({
  delegate: () => prisma.stockLevel,
  fieldMap: FIELD_MAP,
  toApi: (row) => wrapStockLevelDoc(stockLevelToApi(row)),
  translateCreate: stockLevelTranslateCreate,
  translateUpdate: stockLevelTranslateUpdate,
  tenantField: 'companyId',
  mutable: true,
});

model.getOrCreate = async function getOrCreate(companyId, productId, warehouseId) {
  const cid = toId(companyId);
  const pid = toId(productId);
  const wid = toId(warehouseId);
  let row = await prisma.stockLevel.findUnique({
    where: { companyId_productId_warehouseId: { companyId: cid, productId: pid, warehouseId: wid } },
  });
  if (row) return wrapStockLevelDoc(stockLevelToApi(row));
  row = await prisma.stockLevel.create({
    data: {
      ...(await stockLevelTranslateCreate({
        company_id: cid,
        product_id: pid,
        warehouse_id: wid,
        qty_on_hand: 0,
        qty_reserved: 0,
        qty_on_order: 0,
        avg_cost: 0,
        total_value: 0,
      })),
    },
  });
  return wrapStockLevelDoc(stockLevelToApi(row));
};

model.recalculateWAC = async function recalculateWAC(companyId, productId, warehouseId, receivedQty, receivedCost) {
  const doc = await model.getOrCreate(companyId, productId, warehouseId);
  const oldQty = doc.qty_on_hand;
  const oldAvg = doc.avg_cost;
  const newQty = oldQty + receivedQty;
  const newAvg = newQty > 0 ? ((oldQty * oldAvg) + (receivedQty * receivedCost)) / newQty : receivedCost;
  doc.qty_on_hand = Math.round(newQty * 10000) / 10000;
  doc.avg_cost = Math.round(newAvg * 1000000) / 1000000;
  doc.total_value = Math.round(doc.qty_on_hand * doc.avg_cost * 100) / 100;
  doc.last_movement_at = new Date();
  doc.last_movement_type = 'receipt';
  return doc.save();
};

model.validateAvailable = async function validateAvailable(companyId, productId, warehouseId, requiredQty) {
  const cid = toId(companyId);
  const row = await prisma.stockLevel.findUnique({
    where: {
      companyId_productId_warehouseId: {
        companyId: cid,
        productId: toId(productId),
        warehouseId: toId(warehouseId),
      },
    },
  });
  if (!row) {
    throw new Error('STOCK_LEVEL_NOT_FOUND: No stock record for this product at this warehouse');
  }
  const onHand = decimalToNumber(row.qtyOnHand, 0);
  const reserved = decimalToNumber(row.qtyReserved, 0);
  const available = onHand - reserved;
  if (available < requiredQty) {
    throw new Error(
      `INSUFFICIENT_STOCK: Required ${requiredQty}, available ${Math.round(available * 10000) / 10000} (on hand ${onHand} minus reserved ${reserved})`,
    );
  }
  return true;
};

module.exports = model;
