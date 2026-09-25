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

  test('maps every current decision-rule family to the intended recommendation', () => {
    const cases = [
      ['finance.negative_net_cash_flow', AI_DOMAINS.FINANCE, RECOMMENDATION_KINDS.REVIEW_CASH_SHORTAGE_RISK],
      ['finance.negative_profitability', AI_DOMAINS.FINANCE, RECOMMENDATION_KINDS.INVESTIGATE_ANOMALY],
      ['finance.negative_gross_margin', AI_DOMAINS.FINANCE, RECOMMENDATION_KINDS.INVESTIGATE_ANOMALY],
      ['finance.possible_duplicate_supplier_payment', AI_DOMAINS.FINANCE, RECOMMENDATION_KINDS.INVESTIGATE_ANOMALY],
      ['sales.material_revenue_decline', AI_DOMAINS.SALES, RECOMMENDATION_KINDS.INVESTIGATE_ANOMALY],
      ['sales.no_invoice_activity', AI_DOMAINS.SALES, RECOMMENDATION_KINDS.INVESTIGATE_ANOMALY],
      ['sales.invoice_without_revenue', AI_DOMAINS.SALES, RECOMMENDATION_KINDS.INVESTIGATE_ANOMALY],
      ['receivables.severely_overdue_balance', AI_DOMAINS.CUSTOMERS, RECOMMENDATION_KINDS.FOLLOW_UP_OVERDUE_RECEIVABLE],
      ['payables.overdue_balance', AI_DOMAINS.PURCHASES, RECOMMENDATION_KINDS.INVESTIGATE_ANOMALY],
      ['tax.compliance_deadline_overdue', AI_DOMAINS.TAX, RECOMMENDATION_KINDS.PREPARE_TAX_PAYMENT_REMINDER],
      ['tax.compliance_deadline_approaching', AI_DOMAINS.TAX, RECOMMENDATION_KINDS.PREPARE_TAX_PAYMENT_REMINDER],
    ];

    for (const [ruleId, domain, kind] of cases) {
      const result = generateRecommendations({ findings: [finding({ id: ruleId, ruleId, domain })] });
      expect(result.recommendations[0].kind).toBe(kind);
    }
  });

  test('uses role, recurrence, financial exposure, and deadline proximity in score factors', () => {
    const result = generateRecommendations({
      findings: [finding({
        id: 'urgent-tax',
        ruleId: 'tax.compliance_deadline_approaching',
        domain: AI_DOMAINS.TAX,
        severity: 'high',
        occurrenceCount: 5,
        metadata: { daysUntilDue: 1, overdueBalance: 300000 },
      })],
      userRoles: ['accountant'],
    });
    const recommendation = result.recommendations[0];
    expect(recommendation.metadata.scoringFactors).toEqual(expect.objectContaining({
      financialImpact: 0.82,
      urgency: 0.98,
      roleRelevance: 1,
      recurrence: 1,
      complianceRisk: 1,
    }));
    expect(recommendation.type).toBe(RECOMMENDATION_TYPES.ACTION_CANDIDATE);
    expect(recommendation.actionIntent).toBe('prepare_tax_payment_reminder');
  });

  test('breaks exact score ties by finding id for stable order', () => {
    const result = generateRecommendations({
      findings: [finding({ id: 'finding_z' }), finding({ id: 'finding_a' })],
    });
    expect(result.recommendations.map((item) => item.sourceFindingIds[0])).toEqual(['finding_a', 'finding_z']);
  });
});
