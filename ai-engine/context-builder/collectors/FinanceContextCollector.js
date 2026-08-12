'use strict';

const { AI_DOMAINS } = require('../../shared/interfaces');
const { addNumericFact, createFact, sourceIdsFrom } = require('../factFactory');
const { runTool } = require('../toolRunner');

const REQUIRED_PERMISSIONS = ['finance.read', 'bank_accounts.read', 'reports.read'];

async function collect({ companyId, dateRange }) {
  const facts = [];
  const warnings = [];
  const args = {
    startDate: dateRange && dateRange.from,
    endDate: dateRange && dateRange.to,
  };

  const results = await Promise.allSettled([
    runTool(companyId, 'get_bank_accounts'),
    runTool(companyId, 'get_profit_loss_summary', args),
    runTool(companyId, 'get_cash_flow_summary', args),
  ]);

  const [bankResult, plResult, cashFlowResult] = results;

  if (bankResult.status === 'fulfilled') {
    const bank = bankResult.value.result;
    const accounts = bank.accounts || bank.bankAccounts || [];
    const accountIds = sourceIdsFrom(accounts, 'get_bank_accounts');
    addNumericFact(facts, {
      companyId,
      domain: AI_DOMAINS.FINANCE,
      label: 'Cash and bank account balance',
      value: bank.totalBalance || bank.total || 0,
      unit: 'RWF',
      sourceMethod: 'get_bank_accounts',
      sourceIds: accountIds,
      permissions: REQUIRED_PERMISSIONS,
    });
    if (accounts.length) {
      facts.push(createFact({
        companyId,
        domain: AI_DOMAINS.FINANCE,
        label: 'Cash and bank account sample',
        value: accounts.slice(0, 10),
        sourceMethod: 'get_bank_accounts',
        sourceIds: accountIds,
        permissions: REQUIRED_PERMISSIONS,
      }));
    }
  } else {
    warnings.push(`Finance collector skipped bank accounts: ${bankResult.reason.message}`);
  }

  if (plResult.status === 'fulfilled') {
    const pl = plResult.value.result;
    addNumericFact(facts, {
      companyId,
      domain: AI_DOMAINS.FINANCE,
      label: 'Profit and loss revenue',
      value: pl.revenue || pl.totalRevenue || 0,
      unit: 'RWF',
      sourceMethod: 'get_profit_loss_summary',
      sourceIds: ['get_profit_loss_summary'],
      permissions: REQUIRED_PERMISSIONS,
    });
    addNumericFact(facts, {
      companyId,
      domain: AI_DOMAINS.FINANCE,
      label: 'Profit and loss net profit',
      value: pl.netProfit || pl.profit || 0,
      unit: 'RWF',
      sourceMethod: 'get_profit_loss_summary',
      sourceIds: ['get_profit_loss_summary'],
      permissions: REQUIRED_PERMISSIONS,
    });
  } else {
    warnings.push(`Finance collector skipped P&L: ${plResult.reason.message}`);
  }

  if (cashFlowResult.status === 'fulfilled') {
    facts.push(createFact({
      companyId,
      domain: AI_DOMAINS.FINANCE,
      label: 'Cash flow summary',
      value: cashFlowResult.value.result,
      sourceMethod: 'get_cash_flow_summary',
      sourceIds: ['get_cash_flow_summary'],
      permissions: REQUIRED_PERMISSIONS,
    }));
  } else {
    warnings.push(`Finance collector skipped cash flow: ${cashFlowResult.reason.message}`);
  }

  return { facts, warnings };
}

module.exports = {
  domain: AI_DOMAINS.FINANCE,
  requiredPermissions: REQUIRED_PERMISSIONS,
  collect,
};

