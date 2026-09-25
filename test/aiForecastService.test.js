'use strict';

jest.mock('../lib/prisma', () => ({
  prisma: { aIForecast: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() } },
}));
jest.mock('../ai-engine/context-builder/ContextBuilder', () => ({ buildContext: jest.fn() }));

const { prisma } = require('../lib/prisma');
const { buildContext } = require('../ai-engine/context-builder/ContextBuilder');
const service = require('../services/aiForecastService');

const user = { id: 'user_1', permissions: ['sales.read'] };
const context = {
  facts: [{ id: 'fact_sales', label: 'Sales timeline for selected period', value: [
    { period: '2026-01', revenue: 100 }, { period: '2026-02', revenue: 120 }, { period: '2026-03', revenue: 110 },
  ], permissions: ['sales.read'] }],
  warnings: [],
  metadata: { requestId: 'request_1', domains: ['sales'] },
};

describe('AI forecast service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    buildContext.mockResolvedValue(context);
    prisma.aIForecast.create.mockImplementation(async ({ data }) => ({ ...data, createdAt: new Date('2026-04-01T00:00:00Z') }));
  });

  test('generates a tenant-bound, evidence-linked forecast and clamps options', async () => {
    const result = await service.generateForecast({
      companyId: 'company_1', user, forecastType: 'revenue', horizon: 99, historyMonths: 2,
      now: new Date('2026-04-15T12:00:00Z'),
    });
    expect(result.companyId).toBe('company_1');
    expect(result.horizon).toBe(12);
    expect(result.dateRange.to).toBe('2026-03-31T23:59:59.999Z');
    expect(result.modelVersion).toBe('kubika-statistical-forecast-v1');
    expect(result.forecast.predictions[0].sourceFactIds).toEqual(['fact_sales']);
    expect(result.assumptions.join(' ')).toMatch(/do not guarantee/i);
    expect(buildContext).toHaveBeenCalledWith(expect.objectContaining({ company: 'company_1', domains: ['sales'] }));
    expect(prisma.aIForecast.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ companyId: 'company_1' }) }));
  });

  test('scopes history lookups to the requesting company', async () => {
    prisma.aIForecast.findMany.mockResolvedValue([]);
    prisma.aIForecast.findUnique.mockResolvedValue(null);
    await service.listForecasts('company_1', ['sales.read']);
    await service.getForecast('company_1', 'forecast_1', ['sales.read']);
    expect(prisma.aIForecast.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { companyId: 'company_1' } }));
    expect(prisma.aIForecast.findUnique).toHaveBeenCalledWith({ where: { companyId_forecastId: { companyId: 'company_1', forecastId: 'forecast_1' } } });
  });

  test('rejects forecast types the caller cannot read', async () => {
    await expect(service.generateForecast({ companyId: 'company_1', user: { id: 'user_2', permissions: [] }, forecastType: 'revenue' }))
      .rejects.toMatchObject({ statusCode: 403 });
  });
});
