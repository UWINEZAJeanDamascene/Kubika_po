'use strict';

const mockState = { findingState: null, alertCount: 0 };
const tx = {
  aIFindingAlertDelivery: {
    create: jest.fn(async ({ data }) => ({ id: data.id })),
    update: jest.fn(async ({ data }) => data),
  },
  aIAlertDailyUsage: {
    upsert: jest.fn(async () => ({})),
    updateMany: jest.fn(async () => ({ count: mockState.alertCount })),
  },
};
const prismaMock = {
  $transaction: jest.fn(async (callback) => callback(tx)),
  companyUser: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  aIFindingUserState: { findUnique: jest.fn() },
  aIFinding: { findUnique: jest.fn() },
  aIBriefing: { upsert: jest.fn(async ({ create }) => create) },
  company: { findMany: jest.fn() },
  aIFindingAlertDelivery: tx.aIFindingAlertDelivery,
};
const buildContext = jest.fn();
const evaluateContext = jest.fn();
const upsertFindings = jest.fn(async (_companyId, findings) => findings);
const createNotification = jest.fn(async () => [{ id: 'notification-id' }]);

jest.doMock('../lib/prisma', () => ({ prisma: prismaMock }));
jest.doMock('../ai-engine/context-builder/ContextBuilder', () => ({ buildContext }));
jest.doMock('../ai-engine/decision-engine', () => ({ evaluateContext: (...args) => evaluateContext(...args) }));
jest.doMock('../ai-engine/recommendation-engine', () => ({ generateRecommendations: jest.fn(() => []) }));
jest.doMock('../services/aiFindingService', () => ({ upsertFindings: (...args) => upsertFindings(...args) }));
jest.doMock('../services/notificationHelper', () => ({ createNotification: (...args) => createNotification(...args) }));

const { runCompanyScan } = require('../services/aiMonitoringService');

describe('AI monitoring scans', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockState.findingState = null;
    mockState.alertCount = 1;
    prismaMock.companyUser.findMany.mockResolvedValue([{ userId: 'member-id', preferences: {} }]);
    prismaMock.aIFindingUserState.findUnique.mockImplementation(async () => mockState.findingState);
    buildContext.mockResolvedValue({
      facts: [{ id: 'fact-1', domain: 'inventory', permissions: ['inventory.read'], value: 3 }],
      warnings: [], metadata: { requestId: 'request-1', domains: ['inventory'] },
    });
    evaluateContext.mockReturnValue({
      version: 'decision-v1', warnings: [],
      findings: [{ id: 'finding-1', domain: 'inventory', ruleId: 'inventory.stockout_risk', title: 'Stock risk', summary: 'Low stock', severity: 'high', confidence: 0.9, evidenceFactIds: ['fact-1'] }],
    });
  });

  test('persists a real-fact daily briefing and sends a high severity finding once', async () => {
    const result = await runCompanyScan({ companyId: 'company-id', domains: ['inventory'], now: new Date('2026-09-25T08:00:00.000Z'), createBriefing: true });
    expect(result.briefingId).toBeTruthy();
    expect(prismaMock.aIBriefing.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ companyId: 'company-id', findings: expect.any(Array), facts: [{ id: 'fact-1', domain: 'inventory', permissions: ['inventory.read'], value: 3 }] }),
    }));
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-id', userId: 'member-id', type: 'ai_finding',
    }));
    expect(result.alerts).toBe(1);
  });

  test('does not alert dismissed or still-snoozed findings', async () => {
    mockState.findingState = { state: 'dismissed', snoozedUntil: null };
    const result = await runCompanyScan({ companyId: 'company-id', domains: ['inventory'], now: new Date('2026-09-25T08:00:00.000Z') });
    expect(createNotification).not.toHaveBeenCalled();
    expect(result.alerts).toBe(0);
  });

  test('records delivery as suppressed when the daily cap is already reached', async () => {
    mockState.alertCount = 0;
    tx.aIAlertDailyUsage.updateMany.mockResolvedValueOnce({ count: 0 });
    const result = await runCompanyScan({ companyId: 'company-id', domains: ['inventory'], now: new Date('2026-09-25T08:00:00.000Z') });
    expect(tx.aIFindingAlertDelivery.update).toHaveBeenCalledWith(expect.objectContaining({ data: { suppressed: true } }));
    expect(createNotification).not.toHaveBeenCalled();
    expect(result.alerts).toBe(0);
  });
});
