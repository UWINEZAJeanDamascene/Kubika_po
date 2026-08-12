'use strict';

const { AI_DOMAINS } = require('../../shared/interfaces');
const { normalizeDomains, normalizeDateRange } = require('../../context-builder/ContextBuilder');
const {
  extractUserPermissions,
  hasPermission,
  filterFactsForPermissions,
} = require('../../context-builder/permissionUtils');

describe('AI Context Builder utilities', () => {
  test('infers domains from query text', () => {
    expect(normalizeDomains(undefined, 'Why are sales and inventory both down?')).toEqual([
      AI_DOMAINS.SALES,
      AI_DOMAINS.INVENTORY,
    ]);
  });

  test('uses explicit valid domains before query inference', () => {
    expect(normalizeDomains(['finance'], 'show stock risk')).toEqual([AI_DOMAINS.FINANCE]);
  });

  test('defaults to core operating domains for broad queries', () => {
    expect(normalizeDomains(undefined, 'Give me a briefing')).toEqual([
      AI_DOMAINS.SALES,
      AI_DOMAINS.INVENTORY,
      AI_DOMAINS.FINANCE,
      AI_DOMAINS.CUSTOMERS,
      AI_DOMAINS.PURCHASES,
    ]);
  });

  test('normalizes date ranges without inventing dates', () => {
    expect(normalizeDateRange({ from: '2026-08-01', to: '2026-08-05' })).toEqual({
      from: '2026-08-01',
      to: '2026-08-05',
    });
    expect(normalizeDateRange()).toEqual({ from: undefined, to: undefined });
  });

  test('extracts wildcard permissions for admin roles', () => {
    expect(extractUserPermissions({ role: 'admin' })).toEqual(['*']);
  });

  test('extracts object and string permissions from roles', () => {
    const permissions = extractUserPermissions({
      role: 'viewer',
      roles: [
        { name: 'custom', permissions: ['products.read', { resource: 'reports', actions: ['read'] }] },
      ],
    });

    expect(permissions).toEqual(expect.arrayContaining(['products.read', 'reports.read']));
  });

  test('filters facts by permission metadata', () => {
    const facts = [
      { id: 'fact_1', permissions: ['products.read'] },
      { id: 'fact_2', permissions: ['payroll.read'] },
    ];

    expect(filterFactsForPermissions(facts, ['products.read']).map((fact) => fact.id)).toEqual(['fact_1']);
    expect(hasPermission(['*'], ['payroll.read'])).toBe(true);
  });
});

