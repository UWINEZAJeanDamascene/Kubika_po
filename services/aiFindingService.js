'use strict';

const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { FINDING_STATUSES } = require('../ai-engine/decision-engine');

const SEVERITY_ORDER = Object.freeze({ critical: 5, high: 4, medium: 3, low: 2, info: 1 });

function serializeFinding(row) {
  if (!row) return null;
  return {
    id: row.findingId,
    companyId: String(row.company),
    domain: row.domain,
    ruleId: row.ruleId,
    title: row.title,
    summary: row.summary,
    severity: row.severity,
    confidence: row.confidence,
    evidenceFactIds: row.evidenceFactIds || [],
    recommendedNextStep: row.recommendedNextStep,
    status: row.status,
    firstDetectedAt: row.firstDetectedAt,
    lastDetectedAt: row.lastDetectedAt,
    occurrenceCount: row.occurrenceCount,
    metadata: row.metadata || {},
  };
}

async function upsertFindings(companyId, findings = []) {
  const tenantId = String(companyId);
  const persisted = [];
  for (const finding of findings) {
    const now = new Date();
    const saved = await prisma.aIFinding.upsert({
      where: { company_findingId: { company: tenantId, findingId: finding.id } },
      create: {
        id: generateObjectId(),
        company: tenantId,
        findingId: finding.id,
        domain: finding.domain,
        ruleId: finding.ruleId,
        title: finding.title,
        summary: finding.summary,
        severity: finding.severity,
        confidence: finding.confidence,
        evidenceFactIds: finding.evidenceFactIds || [],
        recommendedNextStep: finding.recommendedNextStep || null,
        status: finding.status || FINDING_STATUSES.OPEN,
        metadata: finding.metadata || {},
        firstDetectedAt: now,
        lastDetectedAt: now,
        occurrenceCount: 1,
      },
      update: {
        domain: finding.domain,
        ruleId: finding.ruleId,
        title: finding.title,
        summary: finding.summary,
        severity: finding.severity,
        confidence: finding.confidence,
        evidenceFactIds: finding.evidenceFactIds || [],
        recommendedNextStep: finding.recommendedNextStep || null,
        metadata: finding.metadata || {},
        lastDetectedAt: now,
        occurrenceCount: { increment: 1 },
      },
    });
    persisted.push(serializeFinding(saved));
  }
  return persisted;
}

async function listFindings(companyId, options = {}) {
  const where = { company: String(companyId) };
  if (options.status) where.status = String(options.status);
  if (options.domain) where.domain = String(options.domain);
  if (options.severity) where.severity = String(options.severity);
  const parsedLimit = Number(options.limit);
  const take = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(Math.floor(parsedLimit), 200) : 50;
  const rows = await prisma.aIFinding.findMany({
    where,
    orderBy: { lastDetectedAt: 'desc' },
    take,
  });
  return rows
    .sort((a, b) => (SEVERITY_ORDER[b.severity] || 0) - (SEVERITY_ORDER[a.severity] || 0)
      || new Date(b.lastDetectedAt) - new Date(a.lastDetectedAt))
    .map(serializeFinding);
}

async function updateFindingStatus(companyId, findingId, status) {
  if (!Object.values(FINDING_STATUSES).includes(status)) {
    throw new Error(`Invalid finding status. Expected one of: ${Object.values(FINDING_STATUSES).join(', ')}`);
  }
  const existing = await prisma.aIFinding.findUnique({
    where: { company_findingId: { company: String(companyId), findingId: String(findingId) } },
  });
  if (!existing) return null;
  const updated = await prisma.aIFinding.update({
    where: { id: existing.id },
    data: { status },
  });
  return serializeFinding(updated);
}

module.exports = {
  serializeFinding,
  upsertFindings,
  listFindings,
  updateFindingStatus,
};
