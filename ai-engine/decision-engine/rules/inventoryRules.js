'use strict';

const { AI_DOMAINS, FINDING_SEVERITIES } = require('../../shared/interfaces');
const { numberFact } = require('../factAccess');
const { createFinding } = require('../findingFactory');

function evaluateStockoutRisk(context) {
  const risk = numberFact(context, 'Stockout risk count');
  const lowStock = numberFact(context, 'Low stock product count');
  const outOfStock = numberFact(context, 'Out of stock product count');

  const riskValue = risk.value == null
    ? (Number(lowStock.value || 0) + Number(outOfStock.value || 0))
    : risk.value;

  if (!Number.isFinite(riskValue) || riskValue <= 0) return [];

  const evidenceFacts = [risk.fact, lowStock.fact, outOfStock.fact].filter(Boolean);
  const hasOutOfStock = Number(outOfStock.value || 0) > 0;

  return [createFinding({
    companyId: context.companyId,
    ruleId: 'inventory.stockout_risk',
    domain: AI_DOMAINS.INVENTORY,
    title: hasOutOfStock ? 'Products are out of stock' : 'Products are below reorder level',
    summary: hasOutOfStock
      ? `${outOfStock.value} products are out of stock and ${Number(lowStock.value || 0)} are low stock.`
      : `${riskValue} products are at stockout risk.`,
    severity: hasOutOfStock ? FINDING_SEVERITIES.HIGH : FINDING_SEVERITIES.MEDIUM,
    evidenceFacts,
    recommendedNextStep: 'Review low-stock items and prepare supplier reorder proposals for approval.',
    metadata: {
      riskCount: riskValue,
      lowStockCount: Number(lowStock.value || 0),
      outOfStockCount: Number(outOfStock.value || 0),
      ruleCertainty: hasOutOfStock ? 0.92 : 0.86,
    },
  })];
}

module.exports = {
  rulePackId: 'inventory',
  evaluate(context) {
    return [
      ...evaluateStockoutRisk(context),
    ];
  },
};
