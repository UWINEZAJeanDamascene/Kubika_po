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

function recommendationKindForFinding(finding) {
  if (finding.ruleId === 'inventory.stockout_risk') return RECOMMENDATION_KINDS.REORDER_STOCK;
  if (finding.ruleId === 'receivables.overdue_balance') return RECOMMENDATION_KINDS.FOLLOW_UP_OVERDUE_RECEIVABLE;
  if (finding.ruleId === 'tax.vat_collected_estimate') return RECOMMENDATION_KINDS.PREPARE_TAX_PAYMENT_REMINDER;
  if (finding.ruleId === 'finance.cash_balance_non_positive') return RECOMMENDATION_KINDS.REVIEW_CASH_SHORTAGE_RISK;
  if (finding.ruleId && finding.ruleId.includes('supplier')) return RECOMMENDATION_KINDS.REVIEW_SUPPLIER_PRICING;
  if (finding.ruleId && finding.ruleId.includes('slow_moving')) return RECOMMENDATION_KINDS.REDUCE_SLOW_MOVING_INVENTORY;
  return RECOMMENDATION_KINDS.INVESTIGATE_ANOMALY;
}

function recommendationTypeForKind(kind) {
  if ([
    RECOMMENDATION_KINDS.REORDER_STOCK,
    RECOMMENDATION_KINDS.FOLLOW_UP_OVERDUE_RECEIVABLE,
    RECOMMENDATION_KINDS.PREPARE_TAX_PAYMENT_REMINDER,
  ].includes(kind)) {
    return RECOMMENDATION_TYPES.ACTION_CANDIDATE;
  }
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
    type: recommendationTypeForKind(kind),
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
    return String(a.kind).localeCompare(String(b.kind));
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
