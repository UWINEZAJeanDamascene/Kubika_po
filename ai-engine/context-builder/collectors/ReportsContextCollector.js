'use strict';

const { AI_DOMAINS } = require('../../shared/interfaces');
const { createFact } = require('../factFactory');
const { runTool } = require('../toolRunner');

const REQUIRED_PERMISSIONS = ['reports.read', 'finance.read'];

async function collect({ companyId, dateRange }) {
  const facts = [];
  const warnings = [];
  const args = {
    startDate: dateRange && dateRange.from,
    endDate: dateRange && dateRange.to,
  };

  const results = await Promise.allSettled([
    runTool(companyId, 'get_balance_sheet', args),
    runTool(companyId, 'calculate_financial_ratios', args),
  ]);

  const [balanceSheetResult, ratioResult] = results;

  if (balanceSheetResult.status === 'fulfilled') {
    facts.push(createFact({
      companyId,
      domain: AI_DOMAINS.REPORTS,
      label: 'Balance sheet summary',
      value: balanceSheetResult.value.result,
      sourceMethod: 'get_balance_sheet',
      sourceIds: ['get_balance_sheet'],
      permissions: REQUIRED_PERMISSIONS,
    }));
  } else {
    warnings.push(`Reports collector skipped balance sheet: ${balanceSheetResult.reason.message}`);
  }

  if (ratioResult.status === 'fulfilled') {
    facts.push(createFact({
      companyId,
      domain: AI_DOMAINS.REPORTS,
      label: 'Financial ratios',
      value: ratioResult.value.result,
      sourceMethod: 'calculate_financial_ratios',
      sourceIds: ['calculate_financial_ratios'],
      permissions: REQUIRED_PERMISSIONS,
    }));
  } else {
    warnings.push(`Reports collector skipped financial ratios: ${ratioResult.reason.message}`);
  }

  return { facts, warnings };
}

module.exports = {
  domain: AI_DOMAINS.REPORTS,
  requiredPermissions: REQUIRED_PERMISSIONS,
  collect,
};

