'use strict';

const { AI_DOMAINS } = require('../../shared/interfaces');
const { createFact } = require('../../shared/factFactory');
const {
  DECISION_ENGINE_VERSION,
  evaluateContext,
} = require('../../decision-engine');

function fact(label, value, domain = AI_DOMAINS.FINANCE) {
  return createFact({
    companyId: 'company_1',
    domain,
    label,
    value,
    unit: typeof value === 'number' ? 'RWF' : null,
    sourceService: 'DecisionEngineTest',
    sourceMethod: 'fixture',
    sourceIds: [`src_${label.replace(/\s+/g, '_').toLowerCase()}`],
    permissions: ['reports.read'],
    observedAt: '2026-08-05T09:00:00.000Z',
  });
}

function context(facts) {
  return {
    companyId: 'company_1',
    userId: 'user_1',
    permissions: ['reports.read'],
    facts,
    warnings: [],
    metadata: {},
  };
}

describe('AI Decision Engine', () => {
  test('raises a high-severity inventory finding when products are out of stock', () => {
    const decision = evaluateContext(context([
      fact('Low stock product count', 3, AI_DOMAINS.INVENTORY),
      fact('Out of stock product count', 2, AI_DOMAINS.INVENTORY),
      fact('Stockout risk count', 5, AI_DOMAINS.INVENTORY),
    ]));

    expect(decision.version).toBe(DECISION_ENGINE_VERSION);
    expect(decision.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: 'inventory.stockout_risk',
        severity: 'high',
        evidenceFactIds: expect.any(Array),
      }),
    ]));
  });

  test('uses receivables aging evidence for collection-risk findings', () => {
    const decision = evaluateContext(context([
      fact('Receivables aging', { current: 1000, overdue: 800 }, AI_DOMAINS.CUSTOMERS),
      fact('Total client outstanding balance', 1200, AI_DOMAINS.CUSTOMERS),
    ]));

    const finding = decision.findings.find((item) => item.ruleId === 'receivables.overdue_balance');
    expect(finding).toEqual(expect.objectContaining({
      domain: AI_DOMAINS.CUSTOMERS,
      severity: 'high',
      confidence: expect.any(Number),
    }));
    expect(finding.evidenceFactIds).toHaveLength(2);
  });

  test('detects negative profitability and sorts critical findings first', () => {
    const decision = evaluateContext(context([
      fact('Cash and bank account balance', 0, AI_DOMAINS.FINANCE),
      fact('Net profit', -2500, AI_DOMAINS.FINANCE),
      fact('Profit and loss revenue', 10000, AI_DOMAINS.FINANCE),
    ]));

    expect(decision.findings[0]).toEqual(expect.objectContaining({
      ruleId: 'finance.cash_balance_non_positive',
      severity: 'critical',
    }));
    expect(decision.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: 'finance.negative_profitability',
        severity: 'high',
      }),
    ]));
  });

  test('returns rule warnings without failing the whole decision run', () => {
    const decision = evaluateContext(context([]), {
      rulePackImplementations: [
        {
          rulePackId: 'broken_rule',
          evaluate() {
            throw new Error('fixture failure');
          },
        },
      ],
    });

    expect(decision.findings).toEqual([]);
    expect(decision.warnings).toEqual([
      { rulePackId: 'broken_rule', message: 'fixture failure' },
    ]);
  });
});
