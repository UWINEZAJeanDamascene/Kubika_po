'use strict';

const { AI_DOMAINS } = require('../../shared/interfaces');
const { addNumericFact, createFact, sourceIdsFrom } = require('../factFactory');
const { runTool } = require('../toolRunner');
const { extractUserPermissions, hasPermission } = require('../permissionUtils');

const REQUIRED_PERMISSIONS = ['finance.read', 'bank_accounts.read', 'reports.read'];
const AP_PAYMENT_PERMISSIONS = ['payables.read', 'finance.read', 'purchases.read'];
const POSITION_QUERY = /\b(assets?|liabilit(?:y|ies)|loans?|balance sheet|financial position|net worth)\b/i;
const CURRENT_FINANCIAL_POSITION_QUERY = /\b(current(?:ly)?|today|this month|month.to.date|mtd)\b/i;
const FINANCIAL_METRIC_QUERY = /\b(revenue|sales|expenses?|profit|loss|p&l)\b/i;

async function collect({ companyId, dateRange, user, query = '' }) {
  const facts = [];
  const warnings = [];
  const args = {
    startDate: dateRange && dateRange.from,
    endDate: dateRange && dateRange.to,
  };
  const userPermissions = extractUserPermissions(user);
  const useExecutiveSummary =
    CURRENT_FINANCIAL_POSITION_QUERY.test(query) &&
    FINANCIAL_METRIC_QUERY.test(query) &&
    hasPermission(userPermissions, ['reports.read']);
  const profitLossTool = useExecutiveSummary
    ? 'get_executive_financial_summary'
    : 'get_profit_loss_summary';

  const results = await Promise.allSettled([
    runTool(companyId, 'get_bank_accounts'),
    runTool(companyId, profitLossTool, useExecutiveSummary ? {} : args),
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
    if (useExecutiveSummary) {
      facts.push(createFact({
        companyId,
        domain: AI_DOMAINS.FINANCE,
        label: 'Executive dashboard financial position',
        value: pl,
        sourceMethod: profitLossTool,
        sourceIds: [profitLossTool],
        permissions: ['reports.read'],
      }));
    } else {
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
    }
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

  if (POSITION_QUERY.test(query)) {
    const positionResults = await Promise.allSettled([
      runTool(companyId, 'get_balance_sheet', { asOfDate: dateRange && dateRange.to }),
      runTool(companyId, 'get_fixed_assets', { limit: 100 }),
      runTool(companyId, 'get_loans', { limit: 100 }),
    ]);
    const [balanceSheetResult, fixedAssetsResult, loansResult] = positionResults;

    if (balanceSheetResult.status === 'fulfilled') {
      const balanceSheet = balanceSheetResult.value.result;
      facts.push(createFact({
        companyId,
        domain: AI_DOMAINS.FINANCE,
        label: 'General ledger balance sheet position',
        value: balanceSheet,
        sourceMethod: 'get_balance_sheet',
        sourceIds: ['get_balance_sheet'],
        permissions: ['finance.read', 'reports.read'],
      }));
    } else {
      warnings.push(`Finance collector skipped balance sheet: ${balanceSheetResult.reason.message}`);
    }

    if (fixedAssetsResult.status === 'fulfilled') {
      const fixedAssets = fixedAssetsResult.value.result;
      facts.push(createFact({
        companyId,
        domain: AI_DOMAINS.FINANCE,
        label: 'Fixed asset register position',
        value: fixedAssets,
        sourceMethod: 'get_fixed_assets',
        sourceIds: (fixedAssets.assets || []).map((asset) => asset.id).filter(Boolean),
        permissions: ['assets.read', 'finance.read'],
      }));
    } else {
      warnings.push(`Finance collector skipped fixed asset register: ${fixedAssetsResult.reason.message}`);
    }

    if (loansResult.status === 'fulfilled') {
      const loans = loansResult.value.result;
      facts.push(createFact({
        companyId,
        domain: AI_DOMAINS.FINANCE,
        label: 'Loan and liability register position',
        value: loans,
        sourceMethod: 'get_loans',
        sourceIds: (loans.loans || []).map((loan) => loan.id).filter(Boolean),
        permissions: ['loans.read', 'finance.read'],
      }));
    } else {
      warnings.push(`Finance collector skipped loan and liability register: ${loansResult.reason.message}`);
    }
  }

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
