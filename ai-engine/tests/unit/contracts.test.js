'use strict';

const {
  AI_DOMAINS,
  PROPOSAL_STATUSES,
  validateFactRecord,
  validateAIContext,
  assertValidFactRecord,
} = require('../../shared/interfaces');

describe('AI shared contracts', () => {
  const fact = {
    id: 'fact_sales_mtd_001',
    companyId: 'company_1',
    domain: AI_DOMAINS.SALES,
    label: 'Month-to-date sales',
    value: 1200000,
    unit: 'RWF',
    sourceType: 'service',
    sourceService: 'DashboardService',
    sourceMethod: 'getStats',
    sourceIds: ['invoice_1', 'invoice_2'],
    computed: false,
    formula: null,
    permissions: ['reports.read'],
    observedAt: '2026-08-05T09:00:00.000Z',
  };

  test('accepts a valid FactRecord', () => {
    expect(validateFactRecord(fact)).toEqual([]);
    expect(assertValidFactRecord(fact)).toBe(fact);
  });

  test('rejects unsupported domains and missing provenance', () => {
    const errors = validateFactRecord({
      ...fact,
      domain: 'unknown',
      sourceIds: undefined,
    });

    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('domain must be one of'),
      'sourceIds must be an array',
    ]));
  });

  test('accepts a valid AIContext', () => {
    expect(validateAIContext({
      companyId: 'company_1',
      userId: 'user_1',
      permissions: ['reports.read'],
      facts: [fact],
      warnings: [],
      metadata: { requestId: 'req_1' },
    })).toEqual([]);
  });

  test('exports proposal status constants for approval gates', () => {
    expect(PROPOSAL_STATUSES.PENDING_APPROVAL).toBe('pending_approval');
    expect(PROPOSAL_STATUSES.EXECUTED).toBe('executed');
  });
});

