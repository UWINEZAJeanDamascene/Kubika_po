'use strict';

const crypto = require('crypto');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { buildContext } = require('../ai-engine/context-builder/ContextBuilder');
const { extractUserPermissions, hasPermission } = require('../ai-engine/context-builder/permissionUtils');
const { evaluateContext } = require('../ai-engine/decision-engine');
const { generateRecommendations } = require('../ai-engine/recommendation-engine');
const { REPORTS, buildReport } = require('../ai-engine/reports/ReportBuilder');
const { DOMAIN_PERMISSIONS } = require('../ai-engine/monitoring/MonitoringEngine');

function normalizeDateRange(input = {}) {
  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 30);
  const from = input.from ? new Date(input.from) : defaultFrom;
  const to = input.to ? new Date(input.to) : now;
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) {
    throw Object.assign(new Error('dateRange must contain valid dates with from <= to.'), { statusCode: 400 });
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

function visibleReport(report, permissions) {
  const facts = (report.evidence || []).filter((fact) => {
    if (Array.isArray(fact.permissions) && fact.permissions.length) return hasPermission(permissions, fact.permissions);
    return DOMAIN_PERMISSIONS[fact.domain]
      ? hasPermission(permissions, DOMAIN_PERMISSIONS[fact.domain])
      : false;
  });
  const visibleFactIds = new Set(facts.map((fact) => fact.id));
  const findings = (report.findings || []).filter((finding) => {
    const required = DOMAIN_PERMISSIONS[finding.domain];
    if (!required) return false;
    return hasPermission(permissions, required)
      && (finding.evidenceFactIds || []).every((factId) => visibleFactIds.has(factId));
  });
  const visibleFindingIds = new Set(findings.map((finding) => finding.id));
  const recommendations = (report.recommendations || []).filter((recommendation) => {
    const domain = recommendation.metadata?.sourceDomain;
    const required = DOMAIN_PERMISSIONS[domain];
    if (!required) return false;
    return hasPermission(permissions, required)
      && (recommendation.evidenceFactIds || []).every((factId) => visibleFactIds.has(factId))
      && (recommendation.sourceFindingIds || []).every((findingId) => visibleFindingIds.has(findingId));
  });
  const calculations = (report.calculations || []).filter((calculation) =>
    (calculation.evidenceFactIds || []).every((factId) => visibleFactIds.has(factId)));
  const title = report.title || 'AI Report';
  const highSeverityCount = findings.filter((finding) => ['high', 'critical'].includes(finding.severity)).length;
  const executiveSummary = `${title} contains ${facts.length} facts, ${findings.length} findings (${highSeverityCount} high or critical), and ${recommendations.length} recommendations available to your permissions.`;
  const visibleDomains = new Set(facts.map((fact) => fact.domain));
  return {
    ...report,
    executiveSummary,
    evidence: facts,
    findings,
    recommendations,
    calculations,
    metadata: {
      ...(report.metadata || {}),
      factCount: facts.length,
      findingCount: findings.length,
      recommendationCount: recommendations.length,
      evidenceFactIds: facts.map((fact) => fact.id).filter(Boolean),
      domainCoverage: (report.metadata?.domainCoverage || []).filter((coverage) => visibleDomains.has(coverage.domain)),
      rulePacks: (report.metadata?.rulePacks || []).filter((pack) => {
        const domain = ({
          receivables: 'receivables',
          payables: 'payables',
          payment_anomalies: 'finance',
        })[pack] || pack;
        return Boolean(DOMAIN_PERMISSIONS[domain]) && hasPermission(permissions, DOMAIN_PERMISSIONS[domain]);
      }),
    },
  };
}

async function generateReport({ companyId, user, reportType, dateRange }) {
  const definition = REPORTS[reportType];
  if (!definition) throw Object.assign(new Error(`Unsupported reportType. Choose one of: ${Object.keys(REPORTS).join(', ')}`), { statusCode: 400 });
  const permissions = extractUserPermissions(user);
  const requestedDomains = definition.domains;
  const allowedDomains = requestedDomains.filter((domain) => hasPermission(permissions, DOMAIN_PERMISSIONS[domain] || []));
  if (!allowedDomains.length) throw Object.assign(new Error('You do not have read permission for this report.'), { statusCode: 403 });

  const range = normalizeDateRange(dateRange);
  const unavailableDomains = requestedDomains.filter((domain) => !allowedDomains.includes(domain));
  const context = await buildContext({
    user,
    company: String(companyId),
    query: `Generate ${definition.title}`,
    domains: allowedDomains,
    dateRange: range,
    requestId: crypto.randomUUID(),
  });
  if (unavailableDomains.length) {
    context.warnings = [
      ...(context.warnings || []),
      ...unavailableDomains.map((domain) => `The ${domain} section was omitted because the user lacks its read permission.`),
    ];
  }
  const decision = evaluateContext(context);
  const recommendationResult = generateRecommendations({ findings: decision.findings, context, user });
  const report = buildReport({
    companyId,
    reportType,
    dateRange: range,
    context,
    decision,
    recommendations: recommendationResult,
  });
  const reportId = `airpt_${generateObjectId()}`;
  const saved = await prisma.aIReport.create({
    data: {
      id: generateObjectId(),
      reportId,
      companyId: String(companyId),
      createdBy: String(user.id || user._id),
      reportType: report.reportType,
      title: report.title,
      dateRange: report.dateRange,
      executiveSummary: report.executiveSummary,
      findings: report.findings,
      evidence: report.evidence,
      calculations: report.calculations,
      recommendations: report.recommendations,
      missingDataCaveats: report.missingDataCaveats,
      generatedBy: report.generatedBy,
      metadata: report.metadata,
    },
  });
  return visibleReport({ ...saved, id: saved.reportId }, permissions);
}

async function listReports(companyId, permissions, { reportType, limit } = {}) {
  const where = { companyId: String(companyId) };
  if (reportType) {
    if (!REPORTS[reportType]) throw Object.assign(new Error('Unknown AI report type.'), { statusCode: 400 });
    where.reportType = reportType;
  }
  const parsedLimit = Number(limit);
  const rows = await prisma.aIReport.findMany({
    where,
    orderBy: { generatedAt: 'desc' },
    take: Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(100, Math.floor(parsedLimit)) : 25,
  });
  return rows
    .filter((row) => REPORTS[row.reportType]
      && REPORTS[row.reportType].domains.some((domain) => hasPermission(permissions, DOMAIN_PERMISSIONS[domain] || [])))
    .map((row) => visibleReport({ ...row, id: row.reportId }, permissions));
}

async function getReport(companyId, reportId, permissions) {
  const row = await prisma.aIReport.findUnique({
    where: { companyId_reportId: { companyId: String(companyId), reportId: String(reportId) } },
  });
  if (!row || !REPORTS[row.reportType]) return null;
  if (!REPORTS[row.reportType].domains.some((domain) => hasPermission(permissions, DOMAIN_PERMISSIONS[domain] || []))) return null;
  return visibleReport({ ...row, id: row.reportId }, permissions);
}

module.exports = { REPORTS, normalizeDateRange, visibleReport, generateReport, listReports, getReport };
