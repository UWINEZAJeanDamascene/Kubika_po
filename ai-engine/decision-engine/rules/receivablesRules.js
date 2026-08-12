'use strict';

const { AI_DOMAINS, FINDING_SEVERITIES } = require('../../shared/interfaces');
const { numberFact, objectFact } = require('../factAccess');
const { createFinding } = require('../findingFactory');

function overdueFromAging(value) {
  if (!value || typeof value !== 'object') return 0;
  return Number(value.overdue || value.overdueBalance || value.pastDue || value['90+'] || 0);
}

function evaluateOverdueReceivables(context) {
  const aging = objectFact(context, 'Receivables aging');
  const totalOutstanding = numberFact(context, 'Total client outstanding balance');
  const overdue = overdueFromAging(aging.value);

  if (!Number.isFinite(overdue) || overdue <= 0) return [];

  return [createFinding({
    companyId: context.companyId,
    ruleId: 'receivables.overdue_balance',
    domain: AI_DOMAINS.CUSTOMERS,
    title: 'Customer balances need collection follow-up',
    summary: `Receivables aging shows ${overdue} in overdue customer balances.`,
    severity: overdue > Number(totalOutstanding.value || 0) * 0.5
      ? FINDING_SEVERITIES.HIGH
      : FINDING_SEVERITIES.MEDIUM,
    evidenceFacts: [aging.fact, totalOutstanding.fact].filter(Boolean),
    recommendedNextStep: 'Prioritize payment reminders and review high-risk customer accounts before creating any collection action.',
    metadata: {
      overdueBalance: overdue,
      totalOutstandingBalance: totalOutstanding.value,
      ruleCertainty: 0.84,
    },
  })];
}

module.exports = {
  rulePackId: 'receivables',
  evaluate(context) {
    return [
      ...evaluateOverdueReceivables(context),
    ];
  },
};
