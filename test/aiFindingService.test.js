'use strict';

jest.mock('../lib/prisma', () => ({
  prisma: {
    aIFinding: {
      upsert: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

const { prisma } = require('../lib/prisma');
const service = require('../services/aiFindingService');

describe('AI finding PostgreSQL service', () => {
  beforeEach(() => jest.clearAllMocks());

  test('upserts findings with company scope through the Prisma delegate', async () => {
    prisma.aIFinding.upsert.mockResolvedValue({
      findingId: 'finding_1', company: 'company_1', domain: 'finance', ruleId: 'finance.rule',
      title: 'Review cash', summary: 'Cash is low.', severity: 'high', confidence: 0.8,
      evidenceFactIds: ['fact_1'], recommendedNextStep: 'Review cash.', status: 'open',
      occurrenceCount: 1, metadata: {}, firstDetectedAt: new Date(), lastDetectedAt: new Date(),
    });

    const [finding] = await service.upsertFindings('company_1', [{
      id: 'finding_1', companyId: 'company_1', domain: 'finance', ruleId: 'finance.rule',
      title: 'Review cash', summary: 'Cash is low.', severity: 'high', confidence: 0.8,
      evidenceFactIds: ['fact_1'], recommendedNextStep: 'Review cash.',
    }]);

    expect(prisma.aIFinding.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { company_findingId: { company: 'company_1', findingId: 'finding_1' } },
    }));
    expect(finding.companyId).toBe('company_1');
    expect(finding.evidenceFactIds).toEqual(['fact_1']);
  });

  test('scopes reads and status updates by company in PostgreSQL', async () => {
    prisma.aIFinding.findMany.mockResolvedValue([]);
    prisma.aIFinding.findUnique.mockResolvedValue({ id: 'db-id', findingId: 'finding_1', company: 'company_1' });
    prisma.aIFinding.update.mockResolvedValue({
      findingId: 'finding_1', company: 'company_1', domain: 'finance', ruleId: 'finance.rule',
      title: 'Review cash', summary: 'Cash is low.', severity: 'high', confidence: 0.8,
      evidenceFactIds: [], status: 'acknowledged', occurrenceCount: 1, metadata: {},
    });

    await service.listFindings('company_1', { status: 'open', limit: 25 });
    const updated = await service.updateFindingStatus('company_1', 'finding_1', 'acknowledged');

    expect(prisma.aIFinding.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { company: 'company_1', status: 'open' },
      take: 25,
    }));
    expect(prisma.aIFinding.findUnique).toHaveBeenCalledWith({
      where: { company_findingId: { company: 'company_1', findingId: 'finding_1' } },
    });
    expect(updated.status).toBe('acknowledged');
  });
});
