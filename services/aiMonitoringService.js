'use strict';

const crypto = require('crypto');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { buildContext } = require('../ai-engine/context-builder/ContextBuilder');
const { evaluateContext } = require('../ai-engine/decision-engine');
const { generateRecommendations } = require('../ai-engine/recommendation-engine');
const { AI_DOMAINS } = require('../ai-engine/shared/interfaces');
const { dateKey, dateColumn, isHighSeverity } = require('../ai-engine/monitoring/MonitoringEngine');
const AIFindingService = require('./aiFindingService');
const notificationHelper = require('./notificationHelper');

const ALL_DOMAINS = Object.values(AI_DOMAINS).filter((domain) => !['general', 'security', 'payroll'].includes(domain));
const SYSTEM_PERMISSIONS = ['*'];
const DEFAULT_PREFERENCES = Object.freeze({ enabled: true, maxAlertsPerDay: 5, severities: ['high', 'critical'] });

function safePreferences(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const current = input.aiMonitoring && typeof input.aiMonitoring === 'object' ? input.aiMonitoring : {};
  const parsedCap = Number(current.maxAlertsPerDay);
  return {
    ...DEFAULT_PREFERENCES,
    ...current,
    enabled: current.enabled !== false,
    maxAlertsPerDay: Number.isFinite(parsedCap) ? Math.max(0, Math.min(50, Math.floor(parsedCap))) : DEFAULT_PREFERENCES.maxAlertsPerDay,
    severities: Array.isArray(current.severities)
      ? current.severities.filter((severity) => ['high', 'critical'].includes(severity))
      : DEFAULT_PREFERENCES.severities,
  };
}

function systemUser(companyId) {
  // Internal context collection is privileged but always bound to one company.
  return { id: String(companyId), company: String(companyId), role: 'admin', permissions: SYSTEM_PERMISSIONS, roles: [] };
}

async function alertRecipients(companyId) {
  return prisma.companyUser.findMany({
    where: { companyId: String(companyId), status: 'active', user: { isActive: true } },
    select: { userId: true, preferences: true },
  });
}

async function reserveAlert({ companyId, userId, findingId, alertDate, maxAlertsPerDay }) {
  try {
    return await prisma.$transaction(async (tx) => {
      const delivery = await tx.aIFindingAlertDelivery.create({
        data: { id: generateObjectId(), companyId, userId, findingId, alertDate, suppressed: false },
      });
      await tx.aIAlertDailyUsage.upsert({
        where: { companyId_userId_alertDate: { companyId, userId, alertDate } },
        create: { id: generateObjectId(), companyId, userId, alertDate, alertCount: 0 },
        update: {},
      });
      const updated = await tx.aIAlertDailyUsage.updateMany({
        where: { companyId, userId, alertDate, alertCount: { lt: maxAlertsPerDay } },
        data: { alertCount: { increment: 1 } },
      });
      if (!updated.count) {
        await tx.aIFindingAlertDelivery.update({ where: { id: delivery.id }, data: { suppressed: true } });
        return null;
      }
      return delivery;
    });
  } catch (error) {
    if (error && error.code === 'P2002') return null;
    throw error;
  }
}

async function notifyHighSeverity(companyId, findings, now) {
  const recipients = await alertRecipients(companyId);
  const alertDate = dateColumn(dateKey(now));
  let sent = 0;
  for (const finding of findings.filter((item) => isHighSeverity(item.severity))) {
    for (const recipient of recipients) {
      const preferences = safePreferences(recipient.preferences);
      if (!preferences.enabled || !preferences.severities.includes(finding.severity)) continue;
      const state = await prisma.aIFindingUserState.findUnique({
        where: { companyId_userId_findingId: { companyId, userId: recipient.userId, findingId: finding.id } },
      });
      if (state?.state === 'dismissed' || (state?.state === 'snoozed' && state.snoozedUntil > now)) continue;
      const delivery = await reserveAlert({
        companyId, userId: recipient.userId, findingId: finding.id, alertDate,
        maxAlertsPerDay: preferences.maxAlertsPerDay,
      });
      if (!delivery) continue;
      const created = await notificationHelper.createNotification({
        companyId,
        userId: recipient.userId,
        type: 'ai_finding',
        title: finding.title,
        message: finding.summary,
        severity: 'critical',
        link: '/ai/findings',
        metadata: { findingId: finding.id, domain: finding.domain, ruleId: finding.ruleId, severity: finding.severity },
      });
      const first = Array.isArray(created) ? created[0] : created;
      if (first?.id || first?._id) {
        await prisma.aIFindingAlertDelivery.update({
          where: { id: delivery.id }, data: { notificationId: String(first.id || first._id) },
        });
        sent += 1;
      }
    }
  }
  return sent;
}

function briefingSummary(findings, recommendations, facts) {
  const highCount = findings.filter((finding) => isHighSeverity(finding.severity)).length;
  const top = findings.slice().sort((a, b) => ({ critical: 4, high: 3, medium: 2, low: 1 }[b.severity] || 0)
    - ({ critical: 4, high: 3, medium: 2, low: 1 }[a.severity] || 0)).slice(0, 3);
  const highlights = top.map((finding) => finding.title).join('; ');
  return `Daily business briefing: ${facts.length} verified facts, ${findings.length} findings (${highCount} high or critical), and ${recommendations.length} recommendations.${highlights ? ` Priority items: ${highlights}.` : ' No decision-rule risks were detected in the scanned data.'}`;
}

async function runCompanyScan({ companyId, domains = ALL_DOMAINS, now = new Date(), createBriefing = false }) {
  const tenantId = String(companyId);
  const user = systemUser(tenantId);
  const from = new Date(now);
  from.setUTCFullYear(from.getUTCFullYear() - 1);
  const context = await buildContext({
    user,
    company: tenantId,
    query: 'scheduled AI monitoring scan',
    domains,
    dateRange: { from: from.toISOString(), to: now.toISOString() },
    requestId: crypto.randomUUID(),
  });
  const decision = evaluateContext(context);
  const findings = await AIFindingService.upsertFindings(tenantId, decision.findings);
  const alertCount = await notifyHighSeverity(tenantId, decision.findings, now);
  let briefing = null;
  if (createBriefing) {
    const recommendations = generateRecommendations({ findings: decision.findings, context, user });
    const briefingDate = dateColumn(dateKey(now));
    const data = {
      summary: briefingSummary(decision.findings, recommendations, context.facts),
      findings: decision.findings,
      recommendations,
      facts: context.facts,
      evidenceFactIds: Array.from(new Set(context.facts.map((fact) => fact.id).filter(Boolean))),
      warnings: [...(context.warnings || []), ...(decision.warnings || [])],
      metadata: {
        engineVersion: decision.version,
        requestId: context.metadata.requestId,
        domains: context.metadata.domains,
        factCount: context.facts.length,
        generatedAt: now.toISOString(),
        scheduleTimezone: 'Africa/Kigali',
      },
    };
    briefing = await prisma.aIBriefing.upsert({
      where: { companyId_briefingDate: { companyId: tenantId, briefingDate } },
      create: { id: generateObjectId(), companyId: tenantId, briefingDate, ...data },
      update: data,
    });
  }
  return { companyId: tenantId, findings: findings.length, alerts: alertCount, briefingId: briefing?.id || null, warnings: decision.warnings || [] };
}

async function runScanForAllCompanies(options = {}) {
  const companies = await prisma.company.findMany({
    where: { isActive: true, approvalStatus: 'approved' },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  const results = [];
  for (const company of companies) {
    try {
      results.push(await runCompanyScan({ ...options, companyId: company.id }));
    } catch (error) {
      console.error(`[ai-monitoring] Company ${company.id} scan failed:`, error.message || error);
      results.push({ companyId: company.id, error: error.message || String(error) });
    }
  }
  return results;
}

async function getLatestBriefing(companyId, userId) {
  const membership = await prisma.companyUser.findUnique({
    where: { userId_companyId: { userId: String(userId), companyId: String(companyId) } },
    select: { status: true },
  });
  if (!membership || membership.status !== 'active') throw Object.assign(new Error('Active company membership required.'), { statusCode: 403 });
  return prisma.aIBriefing.findFirst({ where: { companyId: String(companyId) }, orderBy: { briefingDate: 'desc' } });
}

async function getPreferences(companyId, userId) {
  const row = await prisma.companyUser.findUnique({ where: { userId_companyId: { userId: String(userId), companyId: String(companyId) } } });
  if (!row || row.status !== 'active') throw Object.assign(new Error('Active company membership required.'), { statusCode: 403 });
  return safePreferences(row.preferences);
}

async function updatePreferences(companyId, userId, input = {}) {
  const row = await prisma.companyUser.findUnique({ where: { userId_companyId: { userId: String(userId), companyId: String(companyId) } } });
  if (!row || row.status !== 'active') throw Object.assign(new Error('Active company membership required.'), { statusCode: 403 });
  const current = safePreferences(row.preferences);
  const next = safePreferences({ aiMonitoring: { ...current, ...input } });
  const previous = row.preferences && typeof row.preferences === 'object' && !Array.isArray(row.preferences) ? row.preferences : {};
  await prisma.companyUser.update({
    where: { userId_companyId: { userId: String(userId), companyId: String(companyId) } },
    data: { preferences: { ...previous, aiMonitoring: next } },
  });
  return next;
}

async function setFindingState(companyId, userId, findingId, state, snoozedUntil = null) {
  const tenantId = String(companyId);
  const personId = String(userId);
  const membership = await prisma.companyUser.findUnique({
    where: { userId_companyId: { userId: personId, companyId: tenantId } }, select: { status: true },
  });
  if (!membership || membership.status !== 'active') throw Object.assign(new Error('Active company membership required.'), { statusCode: 403 });
  const finding = await prisma.aIFinding.findUnique({ where: { company_findingId: { company: tenantId, findingId: String(findingId) } }, select: { id: true } });
  if (!finding) return null;
  return prisma.aIFindingUserState.upsert({
    where: { companyId_userId_findingId: { companyId: tenantId, userId: personId, findingId: String(findingId) } },
    create: { id: generateObjectId(), companyId: tenantId, userId: personId, findingId: String(findingId), state, snoozedUntil },
    update: { state, snoozedUntil },
  });
}

module.exports = {
  ALL_DOMAINS,
  DEFAULT_PREFERENCES,
  runCompanyScan,
  runScanForAllCompanies,
  getLatestBriefing,
  getPreferences,
  updatePreferences,
  setFindingState,
};
