'use strict';

const { AI_DOMAINS } = require('../../shared/interfaces');
const { addNumericFact, createFact, sourceIdsFrom } = require('../factFactory');
const { runTool } = require('../toolRunner');
const { extractUserPermissions, hasPermission } = require('../permissionUtils');

const REQUIRED_PERMISSIONS = ['finance.read', 'bank_accounts.read', 'reports.read'];
const AP_PAYMENT_PERMISSIONS = ['payables.read', 'finance.read', 'purchases.read'];

async function collect({ companyId, dateRange, user }) {
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
    runTool(companyId, 'get_cash_flow_history', args),
  ]);

  const [bankResult, plResult, cashFlowResult, cashHistoryResult] = results;

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
      label: 'Cost of goods sold',
      value: pl.cogs,
      unit: 'RWF',
      sourceMethod: 'get_profit_loss_summary',
      sourceIds: ['get_profit_loss_summary'],
      computed: Boolean(pl.cogsEstimated),
      formula: pl.cogsEstimated ? 'Estimated as 60% of revenue because no recorded COGS was available.' : null,
      metadata: pl.cogsEstimated ? { caveat: 'COGS is a 60% revenue estimate because recorded invoice-line COGS was unavailable.' } : {},
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

  if (cashHistoryResult.status === 'fulfilled') {
    facts.push(createFact({
      companyId,
      domain: AI_DOMAINS.FINANCE,
      label: 'Cash movement history',
      value: cashHistoryResult.value.result,
      sourceMethod: 'get_cash_flow_history',
      sourceIds: (cashHistoryResult.value.result.monthly || []).map((row) => `bank_transactions:${row.period}`),
      permissions: REQUIRED_PERMISSIONS,
    }));
  } else {
    warnings.push(`Finance collector skipped historical cash movements: ${cashHistoryResult.reason.message}`);
  }

  const userPermissions = extractUserPermissions(user);
  if (hasPermission(userPermissions, AP_PAYMENT_PERMISSIONS)) {
    try {
      const { result: apPayments } = await runTool(companyId, 'get_ap_payments', { limit: 100, ...args });
      const payments = Array.isArray(apPayments.payments) ? apPayments.payments : [];
      if (payments.length) {
        const grantedPermissions = userPermissions.includes('*')
          ? AP_PAYMENT_PERMISSIONS
          : AP_PAYMENT_PERMISSIONS.filter((permission) => hasPermission(userPermissions, [permission]));
        facts.push(createFact({
          companyId,
          domain: AI_DOMAINS.FINANCE,
          label: 'Accounts payable payment sample',
          value: payments,
          sourceMethod: 'get_ap_payments',
          sourceIds: payments.map((payment) => payment.paymentNumber).filter(Boolean).map(String).slice(0, 100),
          permissions: grantedPermissions,
          metadata: { sampleCount: payments.length, limited: payments.length >= 100 },
        }));
      }
    } catch (error) {
      warnings.push(`Finance collector skipped AP payment sample: ${error.message}`);
    }
  }

  return { facts, warnings };
}

module.exports = {
  domain: AI_DOMAINS.FINANCE,
  requiredPermissions: REQUIRED_PERMISSIONS,
  collect,
};
