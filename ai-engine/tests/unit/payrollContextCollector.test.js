'use strict';

jest.mock('../../../services/monthlyReportsService', () => ({
  getPayrollSummary: jest.fn(),
}));

const MonthlyReportsService = require('../../../services/monthlyReportsService');
const { collect } = require('../../context-builder/collectors/PayrollContextCollector');

describe('Payroll context collector', () => {
  beforeEach(() => jest.clearAllMocks());

  test('collects aggregate payroll facts with report provenance and no employee details', async () => {
    MonthlyReportsService.getPayrollSummary.mockResolvedValue({
      summary: {
        totalEmployees: 4,
        totalGrossPay: 1200000,
        totalNetPay: 900000,
        totalEmployerCost: 1300000,
        totalPAYE: 100000,
      },
      employees: [{ name: 'Private Employee', netPay: 225000 }],
    });

    const result = await collect({
      companyId: 'company_1',
      dateRange: { from: '2026-08-01', to: '2026-08-31' },
    });

    expect(MonthlyReportsService.getPayrollSummary).toHaveBeenCalledWith('company_1', 2026, 8);
    expect(result.warnings).toEqual([]);
    expect(result.facts).toHaveLength(10);
    expect(result.facts.find((item) => item.label === 'Payroll gross pay (2026-08)')).toEqual(expect.objectContaining({
      domain: 'payroll',
      label: 'Payroll gross pay (2026-08)',
      value: 1200000,
      sourceService: 'MonthlyReportsService',
      sourceMethod: 'getPayrollSummary',
      sourceIds: ['monthly_payroll_summary:2026-08'],
    }));
    expect(result.facts.find((item) => item.label === 'Payroll employer cost for selected period')).toEqual(expect.objectContaining({
      value: 1300000,
      sourceService: 'MonthlyReportsService',
      metadata: { periods: ['2026-08'] },
    }));
    expect(JSON.stringify(result.facts)).not.toContain('Private Employee');
  });

  test('returns a warning when the existing payroll report service fails', async () => {
    MonthlyReportsService.getPayrollSummary.mockRejectedValue(new Error('report unavailable'));

    const result = await collect({
      companyId: 'company_1',
      dateRange: { from: '2026-08-01', to: '2026-08-31' },
    });

    expect(result.facts).toEqual([]);
    expect(result.warnings[0]).toContain('Payroll summary failed for 2026-08');
  });
});
