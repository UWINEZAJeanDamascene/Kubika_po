'use strict';

const { dateKey, dateColumn, filterBriefing, isHighSeverity } = require('../monitoring/MonitoringEngine');
const { hasPermission } = require('../context-builder/permissionUtils');

describe('AI monitoring helpers', () => {
  test('uses the tenant schedule timezone for briefing dates', () => {
    const instant = new Date('2026-09-24T22:30:00.000Z');
    expect(dateKey(instant)).toBe('2026-09-25');
    expect(dateColumn('2026-09-25').toISOString()).toBe('2026-09-25T00:00:00.000Z');
  });

  test('limits briefing facts, findings, and recommendations to granted domains', () => {
    const briefing = {
      findings: [
        { id: 'stock-risk', domain: 'inventory' },
        { id: 'cash-risk', domain: 'finance' },
      ],
      recommendations: [
        { id: 'reorder', metadata: { sourceDomain: 'inventory' } },
        { id: 'cash', metadata: { sourceDomain: 'finance' } },
      ],
      facts: [
        { id: 'stock', domain: 'inventory', permissions: ['inventory.read'] },
        { id: 'cash', domain: 'finance', permissions: ['finance.read'] },
      ],
    };
    const filtered = filterBriefing(briefing, ['inventory.read'], hasPermission);
    expect(filtered.findings.map((item) => item.id)).toEqual(['stock-risk']);
    expect(filtered.recommendations.map((item) => item.id)).toEqual(['reorder']);
    expect(filtered.facts.map((item) => item.id)).toEqual(['stock']);
  });

  test('flags only high and critical severities for push notifications', () => {
    expect(isHighSeverity('high')).toBe(true);
    expect(isHighSeverity('critical')).toBe(true);
    expect(isHighSeverity('medium')).toBe(false);
  });
});
