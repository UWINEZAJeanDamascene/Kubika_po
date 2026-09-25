'use strict';

const { REPORTS, buildReport } = require('../reports/ReportBuilder');

describe('AI report builder', () => {
  test('builds an auditable report with facts, formulas, and deterministic provenance', () => {
    const fact = {
      id: 'fact-1', companyId: 'company-1', domain: 'inventory', label: 'Stock valuation', value: 125,
      unit: 'RWF', sourceIds: ['product-1'], sourceMethod: 'get_inventory_summary', computed: true,
      formula: 'sum(quantity * unitCost)', permissions: ['inventory.read'], observedAt: '2026-09-25T00:00:00.000Z',
    };
    const report = buildReport({
      companyId: 'company-1', reportType: 'inventory_risk', dateRange: { from: '2026-09-01', to: '2026-09-25' },
      context: { facts: [fact], warnings: [] },
      decision: { version: 'decision-v1', findings: [{ id: 'f-1', title: 'Reorder', summary: 'Stock is low', severity: 'high', evidenceFactIds: ['fact-1'] }], warnings: [] },
      recommendations: { version: 'recommendations-v1', recommendations: [{ id: 'r-1', title: 'Reorder stock', evidenceFactIds: ['fact-1'] }] },
      generatedAt: new Date('2026-09-25T00:00:00.000Z'),
    });

    expect(Object.keys(REPORTS)).toHaveLength(7);
    expect(report.executiveSummary).toContain('1 source facts');
    expect(report.calculations[0]).toMatchObject({
      id: 'fact-1', value: 125, formula: 'sum(quantity * unitCost)', evidenceFactIds: ['fact-1'], sourceIds: ['product-1'],
    });
    expect(report.generatedBy).toMatchObject({ provider: 'deterministic', model: 'ai-report-engine-v1', decisionEngineVersion: 'decision-v1' });
  });

  test('records missing domains as caveats instead of implying complete data', () => {
    const report = buildReport({
      companyId: 'company-1', reportType: 'cash_flow_risk', dateRange: {},
      context: { facts: [], warnings: ['Finance collector unavailable.'] },
      decision: { version: 'decision-v1', findings: [], warnings: [] },
      recommendations: { version: 'recommendations-v1', recommendations: [] },
    });
    expect(report.missingDataCaveats).toEqual(expect.arrayContaining([
      'Finance collector unavailable.',
      expect.stringContaining('finance domain'),
      expect.stringContaining('reports domain'),
    ]));
  });
});
