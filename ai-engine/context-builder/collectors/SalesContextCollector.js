'use strict';

const { AI_DOMAINS } = require('../../shared/interfaces');
const { createFact, addNumericFact, sourceIdsFrom } = require('../factFactory');
const { runTool } = require('../toolRunner');

const REQUIRED_PERMISSIONS = ['invoices.read', 'sales.read', 'reports.read'];

async function collect({ companyId, dateRange }) {
  const facts = [];
  const warnings = [];
  const args = {
    period: 'month',
    startDate: dateRange && dateRange.from,
    endDate: dateRange && dateRange.to,
  };

  const [{ result: sales }, { result: invoices }] = await Promise.all([
    runTool(companyId, 'get_sales_summary', args),
    runTool(companyId, 'get_invoices', { limit: 20, startDate: args.startDate, endDate: args.endDate }),
  ]);

  const invoiceIds = sourceIdsFrom(invoices.invoices, 'get_invoices');
  addNumericFact(facts, {
    companyId,
    domain: AI_DOMAINS.SALES,
    label: 'Sales revenue for selected period',
    value: sales.totalRevenue || 0,
    unit: 'RWF',
    sourceMethod: 'get_sales_summary',
    sourceIds: sourceIdsFrom(sales.timeline, 'get_sales_summary'),
    permissions: REQUIRED_PERMISSIONS,
  });
  addNumericFact(facts, {
    companyId,
    domain: AI_DOMAINS.SALES,
    label: 'Sales amount paid for selected period',
    value: sales.totalPaid || 0,
    unit: 'RWF',
    sourceMethod: 'get_sales_summary',
    sourceIds: sourceIdsFrom(sales.timeline, 'get_sales_summary'),
    permissions: REQUIRED_PERMISSIONS,
  });
  addNumericFact(facts, {
    companyId,
    domain: AI_DOMAINS.SALES,
    label: 'Invoice count for selected period',
    value: invoices.count || 0,
    unit: 'count',
    sourceMethod: 'get_invoices',
    sourceIds: invoiceIds,
    permissions: REQUIRED_PERMISSIONS,
  });

  if (sales.timeline) {
    facts.push(createFact({
      companyId,
      domain: AI_DOMAINS.SALES,
      label: 'Sales timeline for selected period',
      value: sales.timeline,
      sourceMethod: 'get_sales_summary',
      sourceIds: sourceIdsFrom(sales.timeline, 'get_sales_summary'),
      permissions: REQUIRED_PERMISSIONS,
    }));
  }

  return { facts, warnings };
}

module.exports = {
  domain: AI_DOMAINS.SALES,
  requiredPermissions: REQUIRED_PERMISSIONS,
  collect,
};

