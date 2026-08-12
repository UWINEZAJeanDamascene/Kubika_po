'use strict';

const { AI_DOMAINS } = require('../../shared/interfaces');
const { addNumericFact, createFact, sourceIdsFrom } = require('../factFactory');
const { runTool } = require('../toolRunner');

const REQUIRED_PERMISSIONS = ['products.read', 'inventory.read', 'stock.read', 'reports.read'];

async function collect({ companyId }) {
  const facts = [];
  const warnings = [];
  const [{ result: summary }, { result: products }] = await Promise.all([
    runTool(companyId, 'get_stock_summary'),
    runTool(companyId, 'get_products', { limit: 20, lowStock: true }),
  ]);

  const productIds = sourceIdsFrom(products.products, 'get_products');
  addNumericFact(facts, {
    companyId,
    domain: AI_DOMAINS.INVENTORY,
    label: 'Total active products',
    value: summary.totalProducts || 0,
    unit: 'count',
    sourceMethod: 'get_stock_summary',
    sourceIds: productIds,
    permissions: REQUIRED_PERMISSIONS,
  });
  addNumericFact(facts, {
    companyId,
    domain: AI_DOMAINS.INVENTORY,
    label: 'Total stock value',
    value: summary.totalStockValue || 0,
    unit: 'RWF',
    sourceMethod: 'get_stock_summary',
    sourceIds: productIds,
    permissions: REQUIRED_PERMISSIONS,
  });
  addNumericFact(facts, {
    companyId,
    domain: AI_DOMAINS.INVENTORY,
    label: 'Low stock product count',
    value: summary.lowStockCount || 0,
    unit: 'count',
    sourceMethod: 'get_stock_summary',
    sourceIds: productIds,
    permissions: REQUIRED_PERMISSIONS,
  });
  addNumericFact(facts, {
    companyId,
    domain: AI_DOMAINS.INVENTORY,
    label: 'Out of stock product count',
    value: summary.outOfStockCount || 0,
    unit: 'count',
    sourceMethod: 'get_stock_summary',
    sourceIds: productIds,
    permissions: REQUIRED_PERMISSIONS,
  });

  if (Array.isArray(products.products) && products.products.length) {
    facts.push(createFact({
      companyId,
      domain: AI_DOMAINS.INVENTORY,
      label: 'Low stock product sample',
      value: products.products.slice(0, 10).map((p) => ({
        id: p.id,
        name: p.name,
        currentStock: p.currentStock,
        unit: p.unit,
        isLowStock: p.isLowStock,
      })),
      sourceMethod: 'get_products',
      sourceIds: productIds,
      permissions: REQUIRED_PERMISSIONS,
    }));
  }

  return { facts, warnings };
}

module.exports = {
  domain: AI_DOMAINS.INVENTORY,
  requiredPermissions: REQUIRED_PERMISSIONS,
  collect,
};

