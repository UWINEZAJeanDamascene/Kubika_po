'use strict';

const { validateAIContext } = require('../shared/interfaces');
const defaultRulePacks = require('./rules');

const DECISION_ENGINE_VERSION = 'decision-engine-v1';

const SEVERITY_WEIGHT = Object.freeze({
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
});

function sortFindings(findings) {
  return findings.slice().sort((a, b) => {
    const severityDelta = (SEVERITY_WEIGHT[b.severity] || 0) - (SEVERITY_WEIGHT[a.severity] || 0);
    if (severityDelta) return severityDelta;
    return Number(b.confidence || 0) - Number(a.confidence || 0);
  });
}

function evaluateContext(context, options = {}) {
  const validationErrors = validateAIContext(context);
  if (validationErrors.length) {
    throw new Error(`Invalid AI context for decision engine: ${validationErrors.join('; ')}`);
  }

  const selectedRulePackIds = Array.isArray(options.rulePacks) && options.rulePacks.length
    ? new Set(options.rulePacks)
    : null;

  const rulePacks = (options.rulePackImplementations || defaultRulePacks)
    .filter((rulePack) => !selectedRulePackIds || selectedRulePackIds.has(rulePack.rulePackId));

  const findings = [];
  const warnings = [];

  for (const rulePack of rulePacks) {
    try {
      const produced = rulePack.evaluate(context, options);
      if (Array.isArray(produced)) findings.push(...produced);
    } catch (error) {
      warnings.push({
        rulePackId: rulePack.rulePackId,
        message: error.message || String(error),
      });
    }
  }

  return {
    version: DECISION_ENGINE_VERSION,
    evaluatedAt: new Date().toISOString(),
    companyId: context.companyId,
    findings: sortFindings(findings),
    warnings,
    metadata: {
      factCount: context.facts.length,
      rulePacks: rulePacks.map((rulePack) => rulePack.rulePackId),
      warningCount: warnings.length,
    },
  };
}

module.exports = {
  DECISION_ENGINE_VERSION,
  evaluateContext,
  sortFindings,
};
