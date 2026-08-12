'use strict';

const { AI_DOMAINS } = require('../../shared/interfaces');
const { addNumericFact, createFact, sourceIdsFrom } = require('../factFactory');
const { runTool } = require('../toolRunner');

const REQUIRED_PERMISSIONS = ['suppliers.read', 'purchases.read', 'reports.read'];

async function collect({ companyId }) {
  const facts = [];
  const warnings = [];
  const { result } = await runTool(companyId, 'get_suppliers', { limit: 20 });
  const suppliers = result.suppliers || [];

  addNumericFact(facts, {
    companyId,
    domain: AI_DOMAINS.SUPPLIERS,
    label: 'Supplier count',
    value: result.count || suppliers.length || 0,
    unit: 'count',
    sourceMethod: 'get_suppliers',
    sourceIds: sourceIdsFrom(suppliers, 'get_suppliers'),
    permissions: REQUIRED_PERMISSIONS,
  });

  if (suppliers.length) {
    facts.push(createFact({
      companyId,
      domain: AI_DOMAINS.SUPPLIERS,
      label: 'Supplier sample',
      value: suppliers.slice(0, 10).map((supplier) => ({ id: supplier.id, name: supplier.name, balance: supplier.balance })),
      sourceMethod: 'get_suppliers',
      sourceIds: sourceIdsFrom(suppliers, 'get_suppliers'),
      permissions: REQUIRED_PERMISSIONS,
    }));
  }

  return { facts, warnings };
}

module.exports = {
  domain: AI_DOMAINS.SUPPLIERS,
  requiredPermissions: REQUIRED_PERMISSIONS,
  collect,
};

