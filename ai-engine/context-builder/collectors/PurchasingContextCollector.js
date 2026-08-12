'use strict';

const { AI_DOMAINS } = require('../../shared/interfaces');
const { addNumericFact, createFact, sourceIdsFrom } = require('../factFactory');
const { runTool } = require('../toolRunner');

const REQUIRED_PERMISSIONS = ['purchases.read', 'suppliers.read', 'reports.read'];

async function collect({ companyId, dateRange }) {
  const facts = [];
  const warnings = [];
  const [{ result: purchases }, { result: suppliers }] = await Promise.all([
    runTool(companyId, 'get_purchases', {
      limit: 20,
      startDate: dateRange && dateRange.from,
      endDate: dateRange && dateRange.to,
    }),
    runTool(companyId, 'get_suppliers', { limit: 20 }),
  ]);

  addNumericFact(facts, {
    companyId,
    domain: AI_DOMAINS.PURCHASES,
    label: 'Purchase count for selected period',
    value: purchases.count || 0,
    unit: 'count',
    sourceMethod: 'get_purchases',
    sourceIds: sourceIdsFrom(purchases.purchases, 'get_purchases'),
    permissions: REQUIRED_PERMISSIONS,
  });

  if (Array.isArray(purchases.purchases)) {
    facts.push(createFact({
      companyId,
      domain: AI_DOMAINS.PURCHASES,
      label: 'Recent purchases sample',
      value: purchases.purchases.slice(0, 10),
      sourceMethod: 'get_purchases',
      sourceIds: sourceIdsFrom(purchases.purchases, 'get_purchases'),
      permissions: REQUIRED_PERMISSIONS,
    }));
  }

  if (Array.isArray(suppliers.suppliers)) {
    facts.push(createFact({
      companyId,
      domain: AI_DOMAINS.SUPPLIERS,
      label: 'Supplier sample',
      value: suppliers.suppliers.slice(0, 10),
      sourceMethod: 'get_suppliers',
      sourceIds: sourceIdsFrom(suppliers.suppliers, 'get_suppliers'),
      permissions: REQUIRED_PERMISSIONS,
    }));
  }

  return { facts, warnings };
}

module.exports = {
  domain: AI_DOMAINS.PURCHASES,
  requiredPermissions: REQUIRED_PERMISSIONS,
  collect,
};

