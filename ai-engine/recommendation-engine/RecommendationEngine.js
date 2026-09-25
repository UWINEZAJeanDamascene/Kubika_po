'use strict';

const { AI_DOMAINS, RECOMMENDATION_TYPES } = require('../shared/interfaces');
const { createRecommendation } = require('./recommendationFactory');
const { scoreRecommendation } = require('./scoring');
const { RECOMMENDATION_KINDS } = require('./recommendationTypes');

const RECOMMENDATION_ENGINE_VERSION = 'recommendation-engine-v1';

function findingId(finding) {
  return finding.id || finding.findingId;
}

function titleForFinding(finding, kind) {
  if (kind === RECOMMENDATION_KINDS.REORDER_STOCK) return 'Reorder stock at risk';
  if (kind === RECOMMENDATION_KINDS.FOLLOW_UP_OVERDUE_RECEIVABLE) return 'Follow up overdue receivables';
  if (kind === RECOMMENDATION_KINDS.PREPARE_TAX_PAYMENT_REMINDER) return 'Prepare tax payment reminder';
  if (kind === RECOMMENDATION_KINDS.REVIEW_CASH_SHORTAGE_RISK) return 'Review cash shortage risk';
  if (kind === RECOMMENDATION_KINDS.REVIEW_SUPPLIER_PRICING) return 'Review supplier pricing';
  if (kind === RECOMMENDATION_KINDS.REDUCE_SLOW_MOVING_INVENTORY) return 'Reduce slow-moving inventory';
  return `Investigate ${finding.domain || 'business'} anomaly`;
}

const RULE_RECOMMENDATION_KINDS = Object.freeze({
  'inventory.stockout_risk': RECOMMENDATION_KINDS.REORDER_STOCK,
  'inventory.slow_moving_inventory': RECOMMENDATION_KINDS.REDUCE_SLOW_MOVING_INVENTORY,
  'receivables.overdue_balance': RECOMMENDATION_KINDS.FOLLOW_UP_OVERDUE_RECEIVABLE,
  'receivables.severely_overdue_balance': RECOMMENDATION_KINDS.FOLLOW_UP_OVERDUE_RECEIVABLE,
  'tax.vat_collected_estimate': RECOMMENDATION_KINDS.PREPARE_TAX_PAYMENT_REMINDER,
  'tax.compliance_deadline_overdue': RECOMMENDATION_KINDS.PREPARE_TAX_PAYMENT_REMINDER,
  'tax.compliance_deadline_approaching': RECOMMENDATION_KINDS.PREPARE_TAX_PAYMENT_REMINDER,
  'finance.cash_balance_non_positive': RECOMMENDATION_KINDS.REVIEW_CASH_SHORTAGE_RISK,
  'finance.negative_net_cash_flow': RECOMMENDATION_KINDS.REVIEW_CASH_SHORTAGE_RISK,
  'finance.negative_profitability': RECOMMENDATION_KINDS.INVESTIGATE_ANOMALY,
  'finance.negative_gross_margin': RECOMMENDATION_KINDS.INVESTIGATE_ANOMALY,
  'finance.possible_duplicate_supplier_payment': RECOMMENDATION_KINDS.INVESTIGATE_ANOMALY,
  'sales.material_revenue_decline': RECOMMENDATION_KINDS.INVESTIGATE_ANOMALY,
  'sales.no_invoice_activity': RECOMMENDATION_KINDS.INVESTIGATE_ANOMALY,
  'sales.invoice_without_revenue': RECOMMENDATION_KINDS.INVESTIGATE_ANOMALY,
  'payables.overdue_balance': RECOMMENDATION_KINDS.INVESTIGATE_ANOMALY,
  'suppliers.pricing_increase': RECOMMENDATION_KINDS.REVIEW_SUPPLIER_PRICING,
});

function recommendationKindForFinding(finding) {
  if (RULE_RECOMMENDATION_KINDS[finding.ruleId]) return RULE_RECOMMENDATION_KINDS[finding.ruleId];
  if (finding.domain === AI_DOMAINS.INVENTORY && /slow.?moving/i.test(String(finding.ruleId || finding.title || ''))) {
    return RECOMMENDATION_KINDS.REDUCE_SLOW_MOVING_INVENTORY;
  }
  if ([AI_DOMAINS.PURCHASES, AI_DOMAINS.SUPPLIERS].includes(finding.domain)
    && /pricing|price.?increase/i.test(String(finding.ruleId || finding.title || ''))) {
    return RECOMMENDATION_KINDS.REVIEW_SUPPLIER_PRICING;
  }
  return RECOMMENDATION_KINDS.INVESTIGATE_ANOMALY;
}

function recommendationTypeForFinding(finding, kind) {
  if ([
    RECOMMENDATION_KINDS.REORDER_STOCK,
    RECOMMENDATION_KINDS.FOLLOW_UP_OVERDUE_RECEIVABLE,
  ].includes(kind)) {
    return RECOMMENDATION_TYPES.ACTION_CANDIDATE;
  }
  if (kind === RECOMMENDATION_KINDS.PREPARE_TAX_PAYMENT_REMINDER
    && finding.ruleId !== 'tax.vat_collected_estimate') return RECOMMENDATION_TYPES.ACTION_CANDIDATE;
  return RECOMMENDATION_TYPES.INFORMATIONAL;
}

function actionIntentForKind(kind) {
  if (kind === RECOMMENDATION_KINDS.REORDER_STOCK) return 'create_purchase_order';
  if (kind === RECOMMENDATION_KINDS.FOLLOW_UP_OVERDUE_RECEIVABLE) return 'send_payment_reminder';
  if (kind === RECOMMENDATION_KINDS.PREPARE_TAX_PAYMENT_REMINDER) return 'prepare_tax_payment_reminder';
  return null;
}

function buildRationale(finding, score) {
  const lowConfidenceNote = Number(finding.confidence || 0) < 0.65
    ? ' Confidence is low, so verify the source facts before acting.'
    : '';
  return `${finding.summary || finding.title} Priority is based on urgency, impact, confidence, role relevance, recurrence, and compliance exposure.${lowConfidenceNote}`;
}

function recommendationFromFinding(finding, options = {}) {
  const kind = recommendationKindForFinding(finding);
  const score = scoreRecommendation(finding, options);

  return createRecommendation({
    companyId: finding.companyId,
    kind,
    type: recommendationTypeForFinding(finding, kind),
    title: titleForFinding(finding, kind),
    rationale: buildRationale(finding, score),
    priorityScore: score.priorityScore,
    confidence: Number(finding.confidence || 0),
    evidenceFactIds: finding.evidenceFactIds || [],
    sourceFindingIds: [findingId(finding)].filter(Boolean),
    recommendedNextStep: finding.recommendedNextStep,
    actionIntent: actionIntentForKind(kind),
    metadata: {
      sourceRuleId: finding.ruleId,
      sourceDomain: finding.domain || AI_DOMAINS.GENERAL,
      scoringFactors: score.factors,
    },
  });
}

function sortRecommendations(recommendations) {
  return recommendations.slice().sort((a, b) => {
    const priorityDelta = Number(b.priorityScore || 0) - Number(a.priorityScore || 0);
    if (priorityDelta) return priorityDelta;
    const confidenceDelta = Number(b.confidence || 0) - Number(a.confidence || 0);
    if (confidenceDelta) return confidenceDelta;
    const kindDelta = String(a.kind).localeCompare(String(b.kind));
    if (kindDelta) return kindDelta;
    const findingDelta = String(a.sourceFindingIds?.[0] || '').localeCompare(String(b.sourceFindingIds?.[0] || ''));
    if (findingDelta) return findingDelta;
    return String(a.id).localeCompare(String(b.id));
  });
}

function generateRecommendations({ findings = [], context = null, user = null, permissions = [], userRoles = [] } = {}) {
  const effectivePermissions = permissions.length
    ? permissions
    : (context && Array.isArray(context.permissions) ? context.permissions : []);
  const effectiveRoles = userRoles.length
    ? userRoles
    : (user && Array.isArray(user.roles) ? user.roles.map((role) => role.name || role.code || role).filter(Boolean) : []);

  const recommendations = findings
    .filter((finding) => finding && finding.status !== 'dismissed' && finding.status !== 'resolved')
    .map((finding) => recommendationFromFinding(finding, {
      permissions: effectivePermissions,
      userRoles: effectiveRoles,
    }));

  return {
    version: RECOMMENDATION_ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
    companyId: findings[0] && findings[0].companyId || context && context.companyId || null,
    recommendations: sortRecommendations(recommendations),
    metadata: {
      findingCount: findings.length,
      recommendationCount: recommendations.length,
      lowConfidenceCount: recommendations.filter((recommendation) => recommendation.lowConfidence).length,
    },
  };
}

module.exports = {
  RECOMMENDATION_ENGINE_VERSION,
  generateRecommendations,
  recommendationFromFinding,
  sortRecommendations,
};
