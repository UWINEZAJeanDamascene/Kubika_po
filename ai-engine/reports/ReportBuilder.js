'use strict';

const REPORTS = Object.freeze({
  daily_business_briefing: {
    title: 'Daily Business Briefing',
    domains: ['sales', 'inventory', 'finance', 'customers', 'purchases', 'suppliers', 'tax', 'reports'],
  },
  inventory_risk: { title: 'Inventory Risk Report', domains: ['inventory'] },
  cash_flow_risk: { title: 'Cash Flow Risk Report', domains: ['finance', 'reports'] },
  receivables_collection: { title: 'Receivables Collection Risk Report', domains: ['customers', 'finance'] },
  payables_pressure: { title: 'Payables Pressure Report', domains: ['purchases', 'suppliers', 'finance'] },
  sales_performance: { title: 'Sales Performance Report', domains: ['sales'] },
  anomaly_fraud_review: { title: 'Anomaly and Fraud Review Report', domains: ['finance', 'purchases', 'sales'] },
});

const ENGINE_VERSION = 'ai-report-engine-v1';

function makeSummary(title, findings, evidence, recommendations) {
  const priorities = findings.slice(0, 3).map((finding) => finding.title).filter(Boolean);
  const high = findings.filter((finding) => ['high', 'critical'].includes(finding.severity)).length;
  const base = `${title} contains ${evidence.length} source facts, ${findings.length} rule-based findings (${high} high or critical), and ${recommendations.length} recommendations.`;
  return priorities.length ? `${base} Priority findings: ${priorities.join('; ')}.` : `${base} No findings were produced by the configured deterministic rules.`;
}

function buildReport({ companyId, reportType, dateRange, context, decision, recommendations, generatedAt = new Date() }) {
  const definition = REPORTS[reportType];
  if (!definition) throw new Error(`Unsupported AI report type: ${reportType}`);
  const facts = context.facts || [];
  const findings = decision.findings || [];
  const recommendationRows = recommendations.recommendations || [];
  const presentDomains = new Set(facts.map((fact) => fact.domain));
  const missingDataCaveats = [
    ...(context.warnings || []),
    ...(decision.warnings || []).map((warning) => `${warning.rulePackId || 'Decision rule'}: ${warning.message}`),
    ...definition.domains
      .filter((domain) => !presentDomains.has(domain))
      .map((domain) => `No source facts were available for the ${domain} domain in this report.`),
  ];
  const calculations = facts.filter((fact) => fact.computed).map((fact) => ({
    id: fact.id,
    label: fact.label,
    value: fact.value,
    unit: fact.unit || null,
    formula: fact.formula || null,
    evidenceFactIds: fact.id ? [fact.id] : [],
    sourceIds: fact.sourceIds || [],
    sourceMethod: fact.sourceMethod,
  }));

  return {
    companyId: String(companyId),
    reportType,
    title: definition.title,
    dateRange,
    executiveSummary: makeSummary(definition.title, findings, facts, recommendationRows),
    findings,
    evidence: facts,
    calculations,
    recommendations: recommendationRows,
    missingDataCaveats: Array.from(new Set(missingDataCaveats)),
    generatedBy: {
      provider: 'deterministic',
      model: ENGINE_VERSION,
      version: ENGINE_VERSION,
      decisionEngineVersion: decision.version,
      recommendationEngineVersion: recommendations.version,
    },
    metadata: {
      generatedAt: generatedAt.toISOString(),
      factCount: facts.length,
      findingCount: findings.length,
      recommendationCount: recommendationRows.length,
      evidenceFactIds: facts.map((fact) => fact.id).filter(Boolean),
      domainCoverage: definition.domains.map((domain) => ({ domain, hasFacts: presentDomains.has(domain) })),
      rulePacks: decision.metadata?.rulePacks || [],
    },
  };
}

module.exports = { REPORTS, ENGINE_VERSION, buildReport };
