'use strict';

const {
  INTENTS,
  ACTION_TYPES,
  classifyQuery,
  actionProposalReply,
  clarificationReply,
} = require('../../nlq');

describe('Natural Language Query Engine', () => {
  test('classifies action intent and action type', () => {
    const result = classifyQuery('Create a purchase order for low stock items');
    expect(result.intent).toBe(INTENTS.ACTION_INTENT);
    expect(result.actionType).toBe(ACTION_TYPES.CREATE_PURCHASE_ORDER);
    expect(result.routesToActionEngine).toBe(true);
  });

  test('classifies causal questions separately from factual questions', () => {
    const result = classifyQuery('Why are profits decreasing this month?');
    expect(result.intent).toBe(INTENTS.CAUSAL_QUERY);
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  test('classifies forecast requests', () => {
    const result = classifyQuery('Predict next month revenue');
    expect(result.intent).toBe(INTENTS.FORECAST_QUERY);
  });

  test('classifies report and export requests', () => {
    const result = classifyQuery('Export stock analysis to Excel');
    expect(result.intent).toBe(INTENTS.REPORT_REQUEST);
  });

  test('infers KPI ids from business terms', () => {
    const result = classifyQuery('Show my gross margin and VAT collected');
    expect(result.kpis).toEqual(expect.arrayContaining(['gross_margin_pct', 'vat_collected_estimate']));
  });

  test('flags ambiguous short followups for clarification', () => {
    const result = classifyQuery('do it');
    expect(result.intent).toBe(INTENTS.AMBIGUOUS_QUERY);
    expect(result.requiresClarification).toBe(true);
    expect(clarificationReply()).toContain('clarify');
  });

  test('builds action proposal handoff copy', () => {
    const result = classifyQuery('Send payment reminder to overdue clients');
    expect(actionProposalReply(result)).toContain('action proposal');
  });
});

