'use strict';

const { buildTenantModel } = require('../utils/masterDataCommon');
const { generateObjectId, toIdString } = require('../utils/objectId');
const { decimalToNumber } = require('../utils/decimalHelpers');

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  company: { target: 'companyId', isId: true },
  warehouse: { target: 'warehouseId', isId: true },
  product: { target: 'productId', isId: true },
  totalQty: { target: 'totalQty' },
  totalValue: { target: 'totalValue' },
};

function toApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    warehouse: row.warehouseId,
    product: row.productId,
    totalQty: decimalToNumber(row.totalQty, 0),
    totalValue: decimalToNumber(row.totalValue, 0),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function translateCreate(data = {}) {
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    companyId: toIdString(data.company),
    warehouseId: toIdString(data.warehouse),
    productId: toIdString(data.product),
    totalQty: data.totalQty ?? 0,
    totalValue: data.totalValue ?? 0,
  };
}

function translateUpdate(update = {}) {
  const source = update.$set ? { ...update, ...update.$set } : { ...update };
  delete source.$set;
  delete source.$inc;
  delete source.$unset;
  const data = {};
  for (const [sourceKey, target] of [['company', 'companyId'], ['warehouse', 'warehouseId'], ['product', 'productId'], ['totalQty', 'totalQty'], ['totalValue', 'totalValue']]) {
    if (source[sourceKey] !== undefined) data[target] = ['companyId', 'warehouseId', 'productId'].includes(target) ? toIdString(source[sourceKey]) : source[sourceKey];
  }
  return data;
}

module.exports = buildTenantModel({
  name: 'WarehouseInventoryCost',
  collection: 'warehouse_inventory_costs',
  delegateName: 'warehouseInventoryCost',
  fieldMap: FIELD_MAP,
  toApi,
  translateCreate,
  translateUpdate,
  mutable: true,
  instanceMethods: {
    getAvgCost() {
      const qty = Number(this.totalQty || 0);
      const value = Number(this.totalValue || 0);
      return qty > 0 ? value / qty : 0;
    },
  },
});
