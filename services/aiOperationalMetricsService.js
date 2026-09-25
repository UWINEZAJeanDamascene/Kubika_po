'use strict';

const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const config = require('../src/config/environment').getConfig();

const EVENT_TYPES = Object.freeze(new Set([
  'chat_request', 'context_build', 'guardrail_rejection',
  'provider_success', 'provider_failure', 'provider_quota',
  'finding_feedback', 'proposal_transition', 'forecast_backtest',
]));
const SAFE_METADATA_KEYS = new Set([
  'feature', 'status', 'feedback', 'attemptCount', 'available', 'method',
  'mae', 'mape', 'errorPercent', 'retryAfter', 'remainingRequests', 'remainingTokens',
  'meanAbsoluteError', 'meanAbsolutePercentageError',
]);
let storageWarningLogged = false;
let lastPruneAttemptAt = 0;

async function pruneExpiredEvents(now = Date.now()) {
  if (now - lastPruneAttemptAt < 24 * 60 * 60 * 1000) return 0;
  lastPruneAttemptAt = now;
  const cutoff = new Date(now - config.ai.metricsRetentionDays * 24 * 60 * 60 * 1000);
  try {
    const result = await prisma.aIOperationalEvent.deleteMany({ where: { occurredAt: { lt: cutoff } } });
    return result.count || 0;
  } catch (error) {
    if (!storageWarningLogged) {
      storageWarningLogged = true;
      console.warn('[ai-metrics] Could not prune expired PostgreSQL telemetry; AI requests will continue.', error.message || error);
    }
    return 0;
  }
}

function safeMetadata(metadata = {}) {
  const safe = {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return safe;
  for (const [key, value] of Object.entries(metadata)) {
    if (!SAFE_METADATA_KEYS.has(key)) continue;
    if (typeof value === 'string') safe[key] = value.slice(0, 80);
    else if (typeof value === 'boolean' || Number.isFinite(value)) safe[key] = value;
  }
  return safe;
}

async function recordEvent({ eventType, companyId = null, durationMs = null, provider = null, outcome = null, metadata = {} }) {
  if (!EVENT_TYPES.has(eventType)) return false;
  const duration = durationMs != null && Number.isFinite(Number(durationMs)) ? Math.max(0, Math.round(Number(durationMs))) : null;
  void pruneExpiredEvents();
  try {
    await prisma.aIOperationalEvent.create({
      data: {
        id: generateObjectId(),
        eventType,
        companyId: companyId == null ? null : String(typeof companyId === 'object' ? companyId.id || companyId._id || '' : companyId) || null,
        durationMs: duration,
        provider: provider ? String(provider).slice(0, 80) : null,
        outcome: outcome ? String(outcome).slice(0, 40) : null,
        metadata: safeMetadata(metadata),
      },
    });
    return true;
  } catch (error) {
    if (!storageWarningLogged) {
      storageWarningLogged = true;
      console.warn('[ai-metrics] PostgreSQL event recording is unavailable; AI requests will continue without telemetry.', error.message || error);
    }
    return false;
  }
}

function mean(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

async function getSummary({ days = 30, companyId = null } = {}) {
  const windowDays = Number.isInteger(Number(days)) ? Math.max(1, Math.min(90, Number(days))) : 30;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const where = { occurredAt: { gte: since } };
  if (companyId) where.companyId = String(companyId);

  const grouped = await prisma.aIOperationalEvent.groupBy({
    by: ['eventType'], where, _count: { _all: true }, _avg: { durationMs: true },
  });
  const counts = Object.fromEntries(grouped.map((row) => [row.eventType, row._count._all]));
  const averages = Object.fromEntries(grouped.map((row) => [row.eventType, row._avg.durationMs]));
  const providerRows = await prisma.aIOperationalEvent.groupBy({
    by: ['eventType', 'provider'],
    where: { ...where, eventType: { in: ['provider_success', 'provider_failure', 'provider_quota'] } },
    _count: { _all: true }, _avg: { durationMs: true },
  });
  const forecastRows = await prisma.aIOperationalEvent.findMany({
    where: { ...where, eventType: 'forecast_backtest' },
    select: { metadata: true }, orderBy: { occurredAt: 'desc' }, take: 1000,
  });
  const successes = counts.provider_success || 0;
  const failures = counts.provider_failure || 0;
  const feedback = await prisma.aIOperationalEvent.groupBy({
    by: ['outcome'], where: { ...where, eventType: 'finding_feedback' }, _count: { _all: true },
  });
  const proposalTransitions = await prisma.aIOperationalEvent.groupBy({
    by: ['outcome'], where: { ...where, eventType: 'proposal_transition' }, _count: { _all: true },
  });
  const outcomeCounts = (rows) => Object.fromEntries(rows.map((row) => [row.outcome || 'unknown', row._count._all]));
  const findingFeedbackCounts = outcomeCounts(feedback);
  const proposalTransitionCounts = outcomeCounts(proposalTransitions);
  const findingFeedbackTotal = (findingFeedbackCounts.accepted || 0) + (findingFeedbackCounts.dismissed || 0);
  const proposalDecisionTotal = (proposalTransitionCounts.approved || 0) + (proposalTransitionCounts.rejected || 0);
  const forecastMetadata = forecastRows.map((row) => row.metadata || {});
  const mapes = forecastMetadata.map((item) => Number(item.meanAbsolutePercentageError)).filter(Number.isFinite);
  const maes = forecastMetadata.map((item) => Number(item.meanAbsoluteError)).filter(Number.isFinite);

  return {
    windowDays,
    since: since.toISOString(),
    counts,
    averageLatencyMs: {
      chat: averages.chat_request == null ? null : Math.round(averages.chat_request),
      contextBuild: averages.context_build == null ? null : Math.round(averages.context_build),
      provider: providerRows.filter((row) => row.eventType === 'provider_success').map((row) => ({
        provider: row.provider, averageMs: row._avg.durationMs == null ? null : Math.round(row._avg.durationMs),
      })),
    },
    guardrailRejectionRate: counts.chat_request ? (counts.guardrail_rejection || 0) / counts.chat_request : null,
    providerFailureRate: successes + failures ? failures / (successes + failures) : null,
    providerQuotaEvents: counts.provider_quota || 0,
    providerOutcomes: providerRows.map((row) => ({
      eventType: row.eventType, provider: row.provider, count: row._count._all,
    })),
    findingFeedback: {
      ...findingFeedbackCounts,
      acceptanceRate: findingFeedbackTotal ? (findingFeedbackCounts.accepted || 0) / findingFeedbackTotal : null,
      dismissalRate: findingFeedbackTotal ? (findingFeedbackCounts.dismissed || 0) / findingFeedbackTotal : null,
    },
    proposalTransitions: {
      ...proposalTransitionCounts,
      approvalRate: proposalDecisionTotal ? (proposalTransitionCounts.approved || 0) / proposalDecisionTotal : null,
      rejectionRate: proposalDecisionTotal ? (proposalTransitionCounts.rejected || 0) / proposalDecisionTotal : null,
    },
    forecastBacktest: {
      samples: forecastRows.length,
      averageMae: mean(maes),
      averageMape: mean(mapes),
      mapeSamples: mapes.length,
    },
  };
}

module.exports = { EVENT_TYPES, safeMetadata, recordEvent, pruneExpiredEvents, getSummary, _internal: { resetWarning: () => { storageWarningLogged = false; lastPruneAttemptAt = 0; } } };
