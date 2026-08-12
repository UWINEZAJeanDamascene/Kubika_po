'use strict';

const { AI_DOMAINS, FINDING_SEVERITIES } = require('../../shared/interfaces');
const { numberFact } = require('../factAccess');
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

module.exports = {
  rulePackId: 'finance',
  evaluate(context) {
    return [
      ...evaluateCashBalance(context),
      ...evaluateProfitability(context),
    ];
  },
};
