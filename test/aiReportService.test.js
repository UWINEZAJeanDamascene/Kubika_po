'use strict';

const mockPrisma = { aIReport: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() } };
const mockBuildContext = jest.fn();
const mockEvaluateContext = jest.fn();
const mockGenerateRecommendations = jest.fn();

jest.doMock('../lib/prisma', () => ({ prisma: mockPrisma }));
jest.doMock('../ai-engine/context-builder/ContextBuilder', () => ({ buildContext: (...args) => mockBuildContext(...args) }));
jest.doMock('../ai-engine/decision-engine', () => ({ evaluateContext: (...args) => mockEvaluateContext(...args) }));
jest.doMock('../ai-engine/recommendation-engine', () => ({ generateRecommendations: (...args) => mockGenerateRecommendations(...args) }));

const service = require('../services/aiReportService');

describe('AI report persistence service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildContext.mockResolvedValue({
      facts: [{ id: 'fact-stock', companyId: 'company-1', domain: 'inventory', label: 'Stock', value: 4, unit: 'units', sourceIds: ['product-1'], sourceMethod: 'get_inventory_summary', computed: false, formula: null, permissions: ['inventory.read'] }],
      warnings: [], metadata: { requestId: 'request-1' },
    });
    mockEvaluateContext.mockReturnValue({ version: 'decision-v1', findings: [], warnings: [], metadata: { rulePacks: [] } });
    mockGenerateRecommendations.mockReturnValue({ version: 'recommendation-v1', recommendations: [] });
    mockPrisma.aIReport.create.mockImplementation(async ({ data }) => ({ ...data, generatedAt: new Date('2026-09-25T00:00:00.000Z') }));
  });

  test('persists a report under the requested tenant and returns its traceable facts', async () => {
    const report = await service.generateReport({
      companyId: 'company-1', user: { id: 'user-1', permissions: ['inventory.read'], roles: [] },
      reportType: 'inventory_risk', dateRange: { from: '2026-09-01', to: '2026-09-25' },
    });
    expect(mockBuildContext).toHaveBeenCalledWith(expect.objectContaining({
      company: 'company-1', domains: ['inventory'], dateRange: expect.objectContaining({ from: expect.stringContaining('2026-09-01') }),
    }));
    expect(mockPrisma.aIReport.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ companyId: 'company-1', createdBy: 'user-1', reportType: 'inventory_risk' }),
    }));
    expect(report.evidence.map((fact) => fact.id)).toEqual(['fact-stock']);
  });

  test('rejects report creation when the user has no permission for its domains', async () => {
    await expect(service.generateReport({
      companyId: 'company-1', user: { id: 'user-1', permissions: ['payroll.read'], roles: [] },
      reportType: 'inventory_risk',
    })).rejects.toMatchObject({ statusCode: 403 });
    expect(mockPrisma.aIReport.create).not.toHaveBeenCalled();
  });

  test('keeps report retrieval tenant-scoped', async () => {
    mockPrisma.aIReport.findUnique.mockResolvedValue(null);
    await service.getReport('tenant-a', 'airpt_123', ['inventory.read']);
    expect(mockPrisma.aIReport.findUnique).toHaveBeenCalledWith({
      where: { companyId_reportId: { companyId: 'tenant-a', reportId: 'airpt_123' } },
    });
  });
});
