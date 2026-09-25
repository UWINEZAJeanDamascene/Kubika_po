'use strict';

const { AI_DOMAINS } = require('../../shared/interfaces');
const { createFact } = require('../../shared/factFactory');
const {
  KNOWLEDGE_MODEL_VERSION,
  findEntity,
  findBusinessTerm,
  inferDomainsFromTerms,
  inferKpisFromTerms,
  resolveBusinessQuestions,
  RWANDA_TERMS,
  MODULE_RELATIONSHIPS,
  listKpis,
  computeKpi,
  computeKpis,
  enrichContextWithKpis,
} = require('../../knowledge-model');

function fact(label, value, domain = AI_DOMAINS.FINANCE, metadata = {}) {
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
    metadata,
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
      'gross_profit',
      'inventory_turnover',
      'days_payable_outstanding',
      'dead_stock_count',
      'vat_collected',
      'vat_payable',
      'payroll_cost_ratio',
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
      metadata: expect.objectContaining({
        inputFactIds: expect.any(Array),
        knowledgeModelVersion: KNOWLEDGE_MODEL_VERSION,
        formulaTrace: expect.objectContaining({
          formula: expect.any(String),
          inputs: expect.arrayContaining([expect.objectContaining({ label: 'Profit and loss net profit' })]),
        }),
      }),
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

  test('computes gross margin directly from source facts when requested alone', () => {
    const result = computeKpi({
      companyId: 'company_1',
      facts: [fact('Profit and loss revenue', 10000), fact('Cost of goods sold', 6500)],
    }, 'gross_margin_pct');

    expect(result.fact.value).toBe(35);
    expect(result.fact.metadata.formulaTrace.inputs).toHaveLength(2);
  });

  test('carries source caveats into derived KPI facts', () => {
    const result = computeKpi({
      companyId: 'company_1',
      facts: [
        fact('Profit and loss revenue', 10000),
        fact('Cost of goods sold', 6000, AI_DOMAINS.FINANCE, { caveat: 'COGS is estimated.' }),
      ],
    }, 'gross_profit');

    expect(result.fact.value).toBe(4000);
    expect(result.fact.metadata.caveats).toContain('COGS is estimated.');
  });

  test('computes the operational and finance KPI definitions from their registered facts', () => {
    const context = {
      companyId: 'company_1',
      metadata: { dateRange: { from: '2026-08-01', to: '2026-08-30' } },
      facts: [
        fact('Cost of goods sold', 6000),
        fact('Total stock value', 3000, AI_DOMAINS.INVENTORY),
        fact('Total supplier outstanding balance', 1000, AI_DOMAINS.PURCHASES),
        fact('Purchases for selected period', 3000, AI_DOMAINS.PURCHASES),
        createFact({
          companyId: 'company_1',
          domain: AI_DOMAINS.INVENTORY,
          label: 'Dead stock candidate count',
          value: 7,
          sourceService: 'AIToolService',
          sourceMethod: 'get_dead_stock_candidates',
          sourceIds: ['product_1', 'product_2', 'product_3', 'product_4', 'product_5', 'product_6', 'product_7'],
          permissions: ['inventory.read'],
          metadata: { deadStockWindowDays: 45 },
        }),
        fact('VAT collected for selected period', 540, AI_DOMAINS.TAX),
        fact('VAT payable for selected period', 300, AI_DOMAINS.TAX),
        fact('Payroll employer cost for selected period', 2000, AI_DOMAINS.PAYROLL),
        fact('Profit and loss revenue', 10000),
      ],
    };

    expect(computeKpi(context, 'inventory_turnover').fact.value).toBe(2);
    expect(computeKpi(context, 'inventory_turnover').fact.metadata.caveats)
      .toContain('Ending inventory value was used as a proxy because average inventory value was unavailable.');
    expect(computeKpi(context, 'days_payable_outstanding').fact.value).toBe(10);
    expect(computeKpi(context, 'dead_stock_count').fact.value).toBe(7);
    expect(computeKpi(context, 'dead_stock_count').fact.metadata.deadStockWindowDays).toBe(45);
    expect(computeKpi(context, 'dead_stock_count').fact.formula)
      .toContain('zero outbound movement in the trailing 45 days');
    expect(computeKpi(context, 'vat_collected').fact.value).toBe(540);
    expect(computeKpi(context, 'vat_payable').fact.value).toBe(300);
    expect(computeKpi(context, 'payroll_cost_ratio').fact.value).toBe(20);
  });

  test('resolves common KPI questions, Rwanda terms, and ERP relationships centrally', () => {
    expect(inferKpisFromTerms('What is our VAT payable and DPO?')).toEqual([
      'days_payable_outstanding',
      'vat_payable',
    ]);
    expect(resolveBusinessQuestions('Show dead stock and payroll cost ratio')).toEqual(expect.arrayContaining([
      expect.objectContaining({ requiredFacts: ['Dead stock candidate count'] }),
      expect.objectContaining({ requiredFacts: ['Payroll employer cost for selected period', 'Profit and loss revenue'] }),
    ]));
    expect(RWANDA_TERMS.taxB.definition).toContain('18%');
    expect(MODULE_RELATIONSHIPS).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'invoice', relation: 'contains', to: 'invoice line' }),
      expect.objectContaining({ from: 'employee', relation: 'included in', to: 'payroll run' }),
    ]));
    expect(inferDomainsFromTerms('show VAT payable')).toContain(AI_DOMAINS.TAX);
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
