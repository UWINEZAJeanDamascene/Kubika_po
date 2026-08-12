'use strict';

const { AI_DOMAINS } = require('../../shared/interfaces');
const { createFact } = require('../../shared/factFactory');
const {
  KNOWLEDGE_MODEL_VERSION,
  findEntity,
  findBusinessTerm,
  inferDomainsFromTerms,
  listKpis,
  computeKpi,
  computeKpis,
  enrichContextWithKpis,
} = require('../../knowledge-model');

function fact(label, value, domain = AI_DOMAINS.FINANCE) {
  return createFact({
    companyId: 'company_1',
    domain,
    label,
    value,
    unit: typeof value === 'number' ? 'RWF' : null,
    sourceService: 'TestService',
    sourceMethod: 'fixture',
    sourceIds: [`src_${label.replace(/\s+/g, '_').toLowerCase()}`],
    permissions: ['reports.read'],
    observedAt: '2026-08-05T09:00:00.000Z',
  });
}

describe('AI Knowledge Model', () => {
  test('resolves entity and business terminology aliases', () => {
    expect(findEntity('SKU').canonical).toBe('product');
    expect(findEntity('debtor').canonical).toBe('client');
    expect(findBusinessTerm('DSO').kpiId).toBe('days_sales_outstanding');
    expect(inferDomainsFromTerms('show customer invoices and stock items')).toEqual(expect.arrayContaining([
      AI_DOMAINS.SALES,
      AI_DOMAINS.CUSTOMERS,
      AI_DOMAINS.INVENTORY,
    ]));
  });

  test('lists KPI definitions without exposing compute functions', () => {
    const kpis = listKpis();
    expect(kpis.map((kpi) => kpi.id)).toEqual(expect.arrayContaining([
      'net_profit',
      'stockout_risk_count',
      'days_sales_outstanding',
    ]));
    expect(kpis[0].compute).toBeUndefined();
  });

  test('computes net profit as a derived fact with provenance', () => {
    const context = {
      companyId: 'company_1',
      facts: [fact('Profit and loss net profit', 2400)],
    };

    const result = computeKpi(context, 'net_profit');
    expect(result.error).toBeNull();
    expect(result.missing).toEqual([]);
    expect(result.fact).toEqual(expect.objectContaining({
      label: 'Net profit',
      value: 2400,
      computed: true,
      formula: 'Net profit = profit and loss net profit from existing report service',
      sourceService: 'KnowledgeModel',
      sourceMethod: 'KPIRegistry',
    }));
    expect(result.fact.sourceIds).toHaveLength(1);
  });

  test('computes chained KPIs when prerequisites are produced earlier', () => {
    const context = {
      companyId: 'company_1',
      facts: [
        fact('Profit and loss revenue', 10000),
        fact('Cost of goods sold', 6000),
      ],
    };

    const result = computeKpis(context, ['gross_profit', 'gross_margin_pct']);
    expect(result.facts.map((computed) => computed.label)).toEqual(['Gross profit', 'Gross margin percent']);
    expect(result.facts[0].value).toBe(4000);
    expect(result.facts[1].value).toBe(40);
  });

  test('reports missing required facts instead of inventing KPI values', () => {
    const result = computeKpi({ companyId: 'company_1', facts: [] }, 'gross_profit');
    expect(result.fact).toBeNull();
    expect(result.missing).toEqual(['Profit and loss revenue', 'Cost of goods sold']);
  });

  test('enriches an AIContext with computed KPI facts and metadata', () => {
    const context = {
      companyId: 'company_1',
      userId: 'user_1',
      permissions: ['reports.read'],
      facts: [
        fact('Low stock product count', 3, AI_DOMAINS.INVENTORY),
        fact('Out of stock product count', 2, AI_DOMAINS.INVENTORY),
      ],
      warnings: [],
      metadata: {},
    };

    const enriched = enrichContextWithKpis(context, ['stockout_risk_count']);
    expect(enriched.facts).toHaveLength(3);
    expect(enriched.facts[2]).toEqual(expect.objectContaining({
      label: 'Stockout risk count',
      value: 5,
      computed: true,
    }));
    expect(enriched.metadata.knowledgeModelVersion).toBe(KNOWLEDGE_MODEL_VERSION);
  });
});

