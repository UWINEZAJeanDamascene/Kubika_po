'use strict';

const { AI_DOMAINS } = require('../shared/interfaces');

const DOMAIN_PERMISSIONS = Object.freeze({
  [AI_DOMAINS.SALES]: ['sales.read', 'invoices.read'],
  [AI_DOMAINS.INVENTORY]: ['products.read', 'inventory.read', 'stock.read'],
  [AI_DOMAINS.FINANCE]: ['finance.read', 'bank_accounts.read', 'reports.read'],
  [AI_DOMAINS.PURCHASES]: ['purchases.read', 'payables.read'],
  [AI_DOMAINS.CUSTOMERS]: ['customers.read', 'invoices.read'],
  receivables: ['customers.read', 'invoices.read', 'finance.read'],
  payables: ['payables.read', 'purchases.read', 'finance.read'],
  [AI_DOMAINS.SUPPLIERS]: ['suppliers.read', 'purchases.read'],
  [AI_DOMAINS.TAX]: ['tax.read'],
  [AI_DOMAINS.REPORTS]: ['reports.read'],
  [AI_DOMAINS.GENERAL]: ['reports.read'],
});

function isHighSeverity(severity) {
  return severity === 'high' || severity === 'critical';
}

function dateKey(date, timeZone = 'Africa/Kigali') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateColumn(date) {
  return new Date(`${date}T00:00:00.000Z`);
}

function readableDomains(permissions, hasPermission) {
  return new Set(Object.entries(DOMAIN_PERMISSIONS)
    .filter(([, required]) => hasPermission(permissions, required))
    .map(([domain]) => domain));
}

function filterBriefing(briefing, permissions, hasPermission) {
  const allowed = readableDomains(permissions, hasPermission);
  const findings = (briefing.findings || []).filter((finding) => allowed.has(finding.domain));
  const recommendations = (briefing.recommendations || []).filter((recommendation) =>
    !(recommendation.domain || recommendation.metadata?.sourceDomain)
      || allowed.has(recommendation.domain || recommendation.metadata.sourceDomain));
  const facts = (briefing.facts || []).filter((fact) => {
    if (Array.isArray(fact.permissions) && fact.permissions.length) {
      return hasPermission(permissions, fact.permissions);
    }
    return !fact.domain || allowed.has(fact.domain);
  });
  return { ...briefing, findings, recommendations, facts };
}

module.exports = { DOMAIN_PERMISSIONS, isHighSeverity, dateKey, dateColumn, filterBriefing };
