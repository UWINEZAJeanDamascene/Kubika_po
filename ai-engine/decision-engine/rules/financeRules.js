'use strict';

const { AI_DOMAINS, FINDING_SEVERITIES } = require('../../shared/interfaces');
const { numberFact, objectFact } = require('../factAccess');
const { createFinding } = require('../findingFactory');

function evaluateCashBalance(context) {
  const cash = numberFact(context, 'Cash and bank account balance');
  if (cash.value == null || cash.value > 0) return [];

  return [createFinding({
    companyId: context.companyId,
    ruleId: 'finance.cash_balance_non_positive',
    domain: AI_DOMAINS.FINANCE,
    title: 'Cash balance is non-positive',
    summary: `Cash and bank balance is ${cash.value}.`,
    severity: FINDING_SEVERITIES.CRITICAL,
    evidenceFacts: [cash.fact].filter(Boolean),
    recommendedNextStep: 'Review current cash position, pending receivables, and upcoming supplier payments before committing new spend.',
    metadata: {
      cashBalance: cash.value,
      ruleCertainty: 0.9,
    },
  })];
}

function evaluateProfitability(context) {
  const netProfit = numberFact(context, 'Net profit');
  const fallbackNetProfit = netProfit.value == null ? numberFact(context, 'Profit and loss net profit') : netProfit;
  const revenue = numberFact(context, 'Profit and loss revenue');

  if (fallbackNetProfit.value == null || fallbackNetProfit.value >= 0) return [];

  return [createFinding({
    companyId: context.companyId,
    ruleId: 'finance.negative_profitability',
    domain: AI_DOMAINS.FINANCE,
    title: 'Profitability is negative',
    summary: revenue.value > 0
      ? `Net profit is ${fallbackNetProfit.value} against revenue of ${revenue.value}.`
      : `Net profit is ${fallbackNetProfit.value}.`,
    severity: revenue.value > 0 ? FINDING_SEVERITIES.HIGH : FINDING_SEVERITIES.MEDIUM,
    evidenceFacts: [fallbackNetProfit.fact, revenue.fact].filter(Boolean),
    recommendedNextStep: 'Review margin, expenses, and product cost drivers before making operational commitments.',
    metadata: {
      netProfit: fallbackNetProfit.value,
      revenue: revenue.value,
      ruleCertainty: 0.87,
    },
  })];
}

function evaluateCashFlow(context) {
  const cashFlow = objectFact(context, 'Cash flow summary');
  const netCashFlow = Number(cashFlow.value?.netCashFlow);
  if (!cashFlow.fact || !Number.isFinite(netCashFlow) || netCashFlow >= 0) return [];
  const bankBalance = numberFact(context, 'Cash and bank account balance');
  const severity = bankBalance.value != null && bankBalance.value < 0
    ? FINDING_SEVERITIES.CRITICAL
    : FINDING_SEVERITIES.HIGH;
  return [createFinding({
    companyId: context.companyId,
    ruleId: 'finance.negative_net_cash_flow',
    domain: AI_DOMAINS.FINANCE,
    title: 'Net cash flow is negative',
    summary: `Net cash flow for the selected period was ${netCashFlow}.`,
    severity,
    evidenceFacts: [cashFlow.fact, bankBalance.fact].filter(Boolean),
    recommendedNextStep: 'Review cash outflows, upcoming obligations, and collection timing before committing additional spend.',
    metadata: { netCashFlow, bankBalance: bankBalance.value, ruleCertainty: 0.86, expectedEvidenceCount: 2 },
  })];
}

function evaluateGrossMargin(context) {
  const revenue = numberFact(context, 'Profit and loss revenue');
  const cogs = numberFact(context, 'Cost of goods sold');
  if (revenue.value == null || revenue.value <= 0 || cogs.value == null || cogs.value <= revenue.value) return [];
  const marginPercent = Number((((revenue.value - cogs.value) / revenue.value) * 100).toFixed(2));
  return [createFinding({
    companyId: context.companyId,
    ruleId: 'finance.negative_gross_margin',
    domain: AI_DOMAINS.FINANCE,
    title: 'Cost of goods sold exceeds revenue',
    summary: `Gross margin is ${marginPercent}% because reported cost of goods sold exceeds revenue.`,
    severity: FINDING_SEVERITIES.HIGH,
    evidenceFacts: [revenue.fact, cogs.fact],
    recommendedNextStep: 'Verify product costs, selling prices, discounts, and the reporting period used for the P&L.',
    metadata: {
      revenue: revenue.value,
      costOfGoodsSold: cogs.value,
      grossMarginPercent: marginPercent,
      ruleCertainty: cogs.fact.computed ? 0.62 : 0.88,
      expectedEvidenceCount: 2,
      modelUncertainty: cogs.fact.computed ? 0.35 : 0,
    },
  })];
}

module.exports = {
  rulePackId: 'finance',
  evaluate(context) {
    return [
      ...evaluateCashBalance(context),
      ...evaluateCashFlow(context),
      ...evaluateProfitability(context),
      ...evaluateGrossMargin(context),
    ];
  },
};
