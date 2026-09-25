'use strict';

jest.mock('../lib/prisma', () => ({
  prisma: {
    aIOperationalEvent: { create: jest.fn(), deleteMany: jest.fn().mockResolvedValue({ count: 0 }), groupBy: jest.fn(), findMany: jest.fn() },
    aIActionProposal: { findUnique: jest.fn() },
  },
}));
jest.mock('../services/AuditLogService', () => ({ log: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/purchaseOrderService', () => ({ createAIDraft: jest.fn() }));

const { prisma } = require('../lib/prisma');
const metrics = require('../services/aiOperationalMetricsService');

function withAIEnvironment(values, callback) {
  const names = ['NODE_ENV', 'AI_ROLLOUT_STAGE', 'AI_FEATURE_FORECASTS_ENABLED',
    'AI_ROLLOUT_INTERNAL_TENANT_IDS', 'AI_ROLLOUT_TEST_COMPANY_ID', 'AI_ROLLOUT_BETA_TENANT_IDS',
    'AI_KILL_PROVIDER_CALLS', 'AI_KILL_SCHEDULED_MONITORING', 'AI_KILL_PROPOSAL_EXECUTION'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const restore = () => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    jest.resetModules();
  };
  let result;
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, values);
    jest.resetModules();
    result = callback(require('../services/aiFeatureFlags'));
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then === 'function') return result.finally(restore);
  restore();
  return result;
}

describe('Phase 14 AI rollout and observability', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rollout allows internal, test-company, and beta tenants only as their stage advances', () => {
    withAIEnvironment({
      NODE_ENV: 'production', AI_ROLLOUT_STAGE: 'internal', AI_FEATURE_FORECASTS_ENABLED: 'true',
      AI_ROLLOUT_INTERNAL_TENANT_IDS: 'internal-co', AI_ROLLOUT_TEST_COMPANY_ID: 'test-co',
      AI_ROLLOUT_BETA_TENANT_IDS: 'beta-co',
    }, (flags) => {
      expect(flags.isTenantFeatureEnabled('forecasts', 'internal-co')).toBe(true);
      expect(flags.isTenantFeatureEnabled('forecasts', 'test-co')).toBe(false);
      expect(flags.isFeatureEnabled('forecasts', { companyId: 'other-co', user: { role: 'platform_admin' } })).toBe(true);
    });

    withAIEnvironment({
      NODE_ENV: 'production', AI_ROLLOUT_STAGE: 'beta', AI_FEATURE_FORECASTS_ENABLED: 'true',
      AI_ROLLOUT_INTERNAL_TENANT_IDS: 'internal-co', AI_ROLLOUT_TEST_COMPANY_ID: 'test-co',
      AI_ROLLOUT_BETA_TENANT_IDS: 'beta-co',
    }, (flags) => {
      expect(flags.isTenantFeatureEnabled('forecasts', 'test-co')).toBe(true);
      expect(flags.isTenantFeatureEnabled('forecasts', 'beta-co')).toBe(true);
      expect(flags.isTenantFeatureEnabled('forecasts', 'other-co')).toBe(false);
    });
  });

  test('global feature-off switch applies to admins too', () => {
    withAIEnvironment({ NODE_ENV: 'production', AI_ROLLOUT_STAGE: 'all', AI_FEATURE_FORECASTS_ENABLED: 'false' }, (flags) => {
      expect(flags.isFeatureEnabled('forecasts', { companyId: 'company-1', user: { role: 'platform_admin' } })).toBe(false);
    });
  });

  test('provider, scheduled-monitoring, and proposal-execution kill switches stop their work', async () => {
    await withAIEnvironment({ NODE_ENV: 'test', AI_KILL_PROVIDER_CALLS: 'true' }, async () => {
      const provider = require('../services/aiProviderService');
      await expect(provider.createCompletion({ messages: [] })).rejects.toMatchObject({
        code: 'AI_PROVIDER_CALLS_DISABLED', statusCode: 503,
      });
    });

    withAIEnvironment({ NODE_ENV: 'test', AI_KILL_SCHEDULED_MONITORING: 'true' }, () => {
      const scheduler = require('../services/aiMonitoringScheduler');
      expect(scheduler.startMonitoringScheduler()).toBe(false);
      scheduler.stopMonitoringScheduler();
    });

    await withAIEnvironment({ NODE_ENV: 'test', AI_KILL_PROPOSAL_EXECUTION: 'true' }, async () => {
      const freshPrisma = require('../lib/prisma').prisma;
      freshPrisma.aIActionProposal.findUnique.mockResolvedValue({
        id: 'row-1', proposalId: 'proposal-1', company: 'company-1', createdBy: 'user-1',
        type: 'purchase_order_draft', status: 'approved', payload: {}, metadata: {},
        evidenceFactIds: [], sourceRecommendationIds: [], sourceFindingIds: [],
        approvalRequiredByRole: ['admin'], riskLevel: 'medium',
      });
      const proposals = require('../services/aiActionProposalService');
      await expect(proposals.executeProposal('company-1', 'proposal-1', { id: 'admin', permissions: ['*'] }))
        .rejects.toMatchObject({ statusCode: 503 });
    });
  });

  test('event recording keeps bounded operational metadata and excludes identifying fields', async () => {
    prisma.aIOperationalEvent.create.mockResolvedValue({ id: 'event-1' });
    await metrics.recordEvent({
      eventType: 'provider_quota', companyId: { id: 'company-1' }, provider: 'groq', outcome: 'quota',
      metadata: { retryAfter: '20', remainingTokens: '0', email: 'person@example.com', prompt: 'private prompt' },
    });

    expect(prisma.aIOperationalEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      companyId: 'company-1', eventType: 'provider_quota',
      metadata: { retryAfter: '20', remainingTokens: '0' },
    }) });
  });

  test('summary calculates safety, provider, feedback, proposal, and forecast signals', async () => {
    prisma.aIOperationalEvent.groupBy.mockImplementation(async ({ by, where }) => {
      if (by.includes('provider')) return [
        { eventType: 'provider_success', provider: 'groq', _count: { _all: 8 }, _avg: { durationMs: 420 } },
        { eventType: 'provider_failure', provider: 'mistral', _count: { _all: 2 }, _avg: { durationMs: null } },
        { eventType: 'provider_quota', provider: 'groq', _count: { _all: 1 }, _avg: { durationMs: null } },
      ];
      if (by.includes('eventType')) return [
        { eventType: 'chat_request', _count: { _all: 10 }, _avg: { durationMs: 1000 } },
        { eventType: 'context_build', _count: { _all: 10 }, _avg: { durationMs: 200 } },
        { eventType: 'guardrail_rejection', _count: { _all: 1 }, _avg: { durationMs: null } },
        { eventType: 'provider_success', _count: { _all: 8 }, _avg: { durationMs: 420 } },
        { eventType: 'provider_failure', _count: { _all: 2 }, _avg: { durationMs: null } },
        { eventType: 'provider_quota', _count: { _all: 1 }, _avg: { durationMs: null } },
      ];
      if (where.eventType === 'finding_feedback') return [
        { outcome: 'accepted', _count: { _all: 3 } }, { outcome: 'dismissed', _count: { _all: 1 } },
      ];
      return [{ outcome: 'approved', _count: { _all: 2 } }, { outcome: 'rejected', _count: { _all: 1 } }];
    });
    prisma.aIOperationalEvent.findMany.mockResolvedValue([
      { metadata: { meanAbsoluteError: 4, meanAbsolutePercentageError: 10 } },
      { metadata: { meanAbsoluteError: 6, meanAbsolutePercentageError: 20 } },
    ]);

    const summary = await metrics.getSummary({ days: 14, companyId: 'company-1' });

    expect(summary.windowDays).toBe(14);
    expect(summary.averageLatencyMs).toEqual(expect.objectContaining({ chat: 1000, contextBuild: 200 }));
    expect(summary.guardrailRejectionRate).toBe(0.1);
    expect(summary.providerFailureRate).toBe(0.2);
    expect(summary.providerQuotaEvents).toBe(1);
    expect(summary.findingFeedback).toEqual({ accepted: 3, dismissed: 1 });
    expect(summary.proposalTransitions).toEqual({ approved: 2, rejected: 1 });
    expect(summary.forecastBacktest).toEqual(expect.objectContaining({ samples: 2, averageMae: 5, averageMape: 15 }));
  });
});
