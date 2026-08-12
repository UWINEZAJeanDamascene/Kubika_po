'use strict';

const { AI_DOMAINS, FINDING_SEVERITIES } = require('../../shared/interfaces');
const { numberFact } = require('../factAccess');
const { createFinding } = require('../findingFactory');

function evaluateVatEstimate(context) {
  const vat = numberFact(context, 'VAT collected estimate');
  if (vat.value == null || vat.value <= 0) return [];

  return [createFinding({
    companyId: context.companyId,
    ruleId: 'tax.vat_collected_estimate',
    domain: AI_DOMAINS.TAX,
    title: 'VAT collected estimate is available',
    summary: `Estimated VAT collected for the selected period is ${vat.value}.`,
    severity: FINDING_SEVERITIES.INFO,
    evidenceFacts: [vat.fact].filter(Boolean),
    recommendedNextStep: 'Reconcile this estimate with filed tax reports before submission or payment.',
    metadata: {
      vatCollectedEstimate: vat.value,
      ruleCertainty: 0.72,
    },
  })];
}

module.exports = {
  rulePackId: 'tax',
  evaluate(context) {
    return [
      ...evaluateVatEstimate(context),
    ];
  },
};
