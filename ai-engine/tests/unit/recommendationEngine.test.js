'use strict';

const { AI_DOMAINS, RECOMMENDATION_TYPES } = require('../../shared/interfaces');
const {
  RECOMMENDATION_ENGINE_VERSION,
  RECOMMENDATION_KINDS,
  generateRecommendations,
} = require('../../recommendation-engine');

function finding(overrides = {}) {
  return {
    id: overrides.id || `finding_${overrides.ruleId || 'fixture'}`,
    companyId: 'company_1',
    domain: AI_DOMAINS.FINANCE,
    ruleId: 'finance.negative_profitability',
    title: 'Fixture finding',
    summary: 'Fixture finding summary.',
    severity: 'medium',
    confidence: 0.8,
    evidenceFactIds: ['fact_1'],
    recommendedNextStep: 'Review the supporting facts.',
    status: 'open',
    createdAt: '2026-08-05T09:00:00.000Z',
    metadata: {},
    ...overrides,
  };
}

describe('AI Recommendation Engine', () => {
  test('maps inventory stockout findings to reorder action candidates', () => {
    const result = generateRecommendations({
      findings: [
        finding({
          id: 'finding_stockout',
          domain: AI_DOMAINS.INVENTORY,
          ruleId: 'inventory.stockout_risk',
          severity: 'high',
          confidence: 0.91,
          metadata: { riskCount: 6 },
        }),
      ],
      context: {
        companyId: 'company_1',
        permissions: ['inventory.read', 'purchase_orders.create'],
      },
    });

    expect(result.version).toBe(RECOMMENDATION_ENGINE_VERSION);
    expect(result.recommendations[0]).toEqual(expect.objectContaining({
      kind: RECOMMENDATION_KINDS.REORDER_STOCK,
      type: RECOMMENDATION_TYPES.ACTION_CANDIDATE,
      actionIntent: 'create_purchase_order',
      confidenceLabel: 'high_confidence',
      sourceFindingIds: ['finding_stockout'],
    }));
  });

  test('sorts recommendations by priority score and then confidence', () => {
    const result = generateRecommendations({
      findings: [
        finding({
          id: 'finding_tax',
          domain: AI_DOMAINS.TAX,
          ruleId: 'tax.vat_collected_estimate',
          severity: 'info',
          confidence: 0.7,
          metadata: { vatCollectedEstimate: 10000 },
        }),
        finding({
          id: 'finding_cash',
          domain: AI_DOMAINS.FINANCE,
          ruleId: 'finance.cash_balance_non_positive',
          severity: 'critical',
          confidence: 0.9,
          metadata: { cashBalance: 0, occurrenceCount: 4 },
        }),
      ],
      permissions: ['finance.reports.read'],
    });

    expect(result.recommendations[0]).toEqual(expect.objectContaining({
      kind: RECOMMENDATION_KINDS.REVIEW_CASH_SHORTAGE_RISK,
    }));
    expect(result.recommendations[0].priorityScore).toBeGreaterThan(result.recommendations[1].priorityScore);
  });

  test('labels low-confidence recommendations clearly', () => {
    const result = generateRecommendations({
      findings: [
        finding({
          id: 'finding_low_confidence',
          confidence: 0.52,
          severity: 'medium',
        }),
      ],
    });

    expect(result.metadata.lowConfidenceCount).toBe(1);
    expect(result.recommendations[0]).toEqual(expect.objectContaining({
      confidenceLabel: 'low_confidence',
      lowConfidence: true,
    }));
    expect(result.recommendations[0].rationale).toContain('Confidence is low');
  });

  test('filters resolved and dismissed findings', () => {
    const result = generateRecommendations({
      findings: [
        finding({ id: 'open' }),
        finding({ id: 'dismissed', status: 'dismissed' }),
        finding({ id: 'resolved', status: 'resolved' }),
      ],
    });

    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0].sourceFindingIds).toEqual(['open']);
  });
});
