'use strict';

const { AI_DOMAINS } = require('../../shared/interfaces');
const { addNumericFact, createFact, sourceIdsFrom } = require('../factFactory');
const { runTool } = require('../toolRunner');

const REQUIRED_PERMISSIONS = ['clients.read', 'customers.read', 'invoices.read', 'reports.read'];

async function collect({ companyId, dateRange }) {
  const facts = [];
  const warnings = [];
  const [{ result: clients }, { result: aging }, receiptsHistory] = await Promise.all([
    runTool(companyId, 'get_clients', { limit: 20 }),
    runTool(companyId, 'get_receivables_aging'),
    runTool(companyId, 'get_receivables_collection_history', {
      startDate: dateRange && dateRange.from,
      endDate: dateRange && dateRange.to,
    }).then((value) => ({ value })).catch((error) => ({ error })),
  ]);

  addNumericFact(facts, {
    companyId,
    domain: AI_DOMAINS.CUSTOMERS,
    label: 'Client count',
    value: clients.count || 0,
    unit: 'count',
    sourceMethod: 'get_clients',
    sourceIds: sourceIdsFrom(clients.clients, 'get_clients'),
    permissions: REQUIRED_PERMISSIONS,
  });
  addNumericFact(facts, {
    companyId,
    domain: AI_DOMAINS.CUSTOMERS,
    label: 'Total client outstanding balance',
    value: clients.totalOutstanding || aging.totalOutstanding || 0,
    unit: 'RWF',
    sourceMethod: 'get_clients',
    sourceIds: sourceIdsFrom(clients.clients, 'get_clients'),
    permissions: REQUIRED_PERMISSIONS,
  });

  facts.push(createFact({
    companyId,
    domain: AI_DOMAINS.CUSTOMERS,
    label: 'Receivables aging',
    value: aging,
    sourceMethod: 'get_receivables_aging',
    sourceIds: ['get_receivables_aging'],
    permissions: REQUIRED_PERMISSIONS,
  }));

  if (receiptsHistory.error) {
    warnings.push(`Receivables collection history unavailable: ${receiptsHistory.error.message}`);
  } else {
    facts.push(createFact({
      companyId,
      domain: AI_DOMAINS.CUSTOMERS,
      label: 'Receivables collection history',
      value: receiptsHistory.value.result,
      sourceMethod: 'get_receivables_collection_history',
      sourceIds: (receiptsHistory.value.result.monthly || []).map((row) => `ar_receipts:${row.period}`),
      permissions: REQUIRED_PERMISSIONS,
    }));
  }

  return { facts, warnings };
}

module.exports = {
  domain: AI_DOMAINS.CUSTOMERS,
  requiredPermissions: REQUIRED_PERMISSIONS,
  collect,
};
