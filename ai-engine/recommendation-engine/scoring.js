'use strict';

const { AI_DOMAINS, FINDING_SEVERITIES } = require('../shared/interfaces');

const SEVERITY_URGENCY = Object.freeze({
  [FINDING_SEVERITIES.CRITICAL]: 1,
  [FINDING_SEVERITIES.HIGH]: 0.82,
  [FINDING_SEVERITIES.MEDIUM]: 0.58,
  [FINDING_SEVERITIES.LOW]: 0.34,
  [FINDING_SEVERITIES.INFO]: 0.16,
});

const DOMAIN_PERMISSION_HINTS = Object.freeze({
  [AI_DOMAINS.INVENTORY]: ['inventory', 'product', 'stock', 'purchase'],
  [AI_DOMAINS.PURCHASES]: ['purchase', 'supplier'],
  [AI_DOMAINS.CUSTOMERS]: ['customer', 'client', 'receivable', 'invoice', 'sales'],
  [AI_DOMAINS.SALES]: ['sales', 'invoice', 'client', 'customer'],
  [AI_DOMAINS.FINANCE]: ['finance', 'account', 'report', 'journal', 'payment'],
  [AI_DOMAINS.TAX]: ['tax', 'vat', 'ebm', 'report'],
});

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function normalize(value) {
  return String(value || '').toLowerCase();
}

function estimateFinancialImpact(finding) {
  const metadata = finding.metadata || {};
  const values = [
    metadata.overdueBalance,
    metadata.totalOutstandingBalance,
    metadata.cashBalance == null ? null : Math.abs(Number(metadata.cashBalance)),
    metadata.netProfit == null ? null : Math.abs(Number(metadata.netProfit)),
    metadata.revenue,
    metadata.vatCollectedEstimate,
    metadata.riskCount == null ? null : Number(metadata.riskCount) * 100,
  ]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);

  if (!values.length) return 0.2;
  const largest = Math.max(...values);
  if (largest >= 1000000) return 1;
  if (largest >= 250000) return 0.82;
  if (largest >= 50000) return 0.62;
  if (largest >= 10000) return 0.42;
  return 0.25;
}

function roleRelevance(finding, options = {}) {
  const permissions = [
    ...((options.permissions || [])),
    ...((options.userRoles || [])),
  ].map(normalize);
  if (!permissions.length) return 0.5;

  const hints = DOMAIN_PERMISSION_HINTS[finding.domain] || [finding.domain];
  const matched = permissions.some((permission) => hints.some((hint) => permission.includes(hint)));
  return matched ? 1 : 0.42;
}

function recurrenceScore(finding) {
  const count = Number(finding.occurrenceCount || finding.metadata && finding.metadata.occurrenceCount || 1);
  return clamp(count / 5, 0.2, 1);
}

function complianceRisk(finding) {
  if (finding.domain === AI_DOMAINS.TAX) return 1;
  if (finding.ruleId && finding.ruleId.includes('cash')) return 0.72;
  if (finding.ruleId && finding.ruleId.includes('receivables')) return 0.45;
  return 0.2;
}

function scoreRecommendation(finding, options = {}) {
  const financialImpact = estimateFinancialImpact(finding);
  const urgency = SEVERITY_URGENCY[finding.severity] || 0.2;
  const confidence = clamp(Number(finding.confidence || 0));
  const relevance = roleRelevance(finding, options);
  const recurrence = recurrenceScore(finding);
  const compliance = complianceRisk(finding);

  const score = (
    financialImpact * 0.25 +
    urgency * 0.25 +
    confidence * 0.2 +
    relevance * 0.15 +
    recurrence * 0.1 +
    compliance * 0.05
  ) * 100;

  return {
    priorityScore: Number(score.toFixed(1)),
    factors: {
      financialImpact,
      urgency,
      confidence,
      roleRelevance: relevance,
      recurrence,
      complianceRisk: compliance,
    },
  };
}

module.exports = {
  scoreRecommendation,
};
