'use strict';

jest.mock('../../../services/monthlyReportsService', () => ({
  getVATReturn: jest.fn(),
}));
jest.mock('../../../services/aiComplianceCalendarService', () => ({
  getComplianceCalendar: jest.fn().mockResolvedValue([]),
}));

const MonthlyReportsService = require('../../../services/monthlyReportsService');
const AIComplianceCalendarService = require('../../../services/aiComplianceCalendarService');
const { collect } = require('../../context-builder/collectors/TaxContextCollector');

describe('Tax context collector', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AIComplianceCalendarService.getComplianceCalendar.mockResolvedValue([]);
  });

  test('collects output VAT and VAT payable from the existing tax report with provenance', async () => {
    MonthlyReportsService.getVATReturn.mockResolvedValue({
      summary: { totalOutputVAT: 180, netVATPAYABLE: 120 },
    });

    const result = await collect({
      companyId: 'company_1',
      dateRange: { from: '2026-08-01', to: '2026-08-31' },
    });

    expect(MonthlyReportsService.getVATReturn).toHaveBeenCalledWith('company_1', 2026, 8);
    expect(result.facts.find((fact) => fact.label === 'VAT collected for selected period')).toEqual(expect.objectContaining({
      value: 180,
      sourceService: 'MonthlyReportsService',
      sourceMethod: 'getVATReturn',
      sourceIds: ['vat_return:2026-08'],
    }));
    expect(result.facts.find((fact) => fact.label === 'VAT payable for selected period').value).toBe(120);
    expect(result.warnings).toEqual([]);
  });

  test('marks calendar-month totals when the requested dates cover only part of a month', async () => {
    MonthlyReportsService.getVATReturn.mockResolvedValue({
      summary: { totalOutputVAT: 180, netVATPAYABLE: 120 },
    });

    const result = await collect({
      companyId: 'company_1',
      dateRange: { from: '2026-08-05', to: '2026-08-30' },
    });

    expect(result.facts.find((fact) => fact.label === 'VAT collected for selected period').metadata.caveat)
      .toContain('full calendar-month totals');
  });

  test('includes configured compliance deadlines as tenant-scoped evidence', async () => {
    MonthlyReportsService.getVATReturn.mockRejectedValue(new Error('No report data'));
    AIComplianceCalendarService.getComplianceCalendar.mockResolvedValue([{
      id: 'tax_entry_1', taxType: 'vat', dueDate: '2026-09-15', status: 'upcoming', period: { month: 8, year: 2026 },
    }]);

    const result = await collect({ companyId: 'company_1', dateRange: {} });

    expect(AIComplianceCalendarService.getComplianceCalendar).toHaveBeenCalledWith('company_1');
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Tax compliance calendar', sourceService: 'AIComplianceCalendarService' }),
    ]));
  });
});
