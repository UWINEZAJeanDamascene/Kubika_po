'use strict';

const {
  INTENTS,
  ACTION_TYPES,
  classifyQuery,
  buildLLMClassificationMessages,
  parseLLMClassification,
  applyLLMClassification,
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

  test('classifies action how-to questions as help rather than execution requests', () => {
    const result = classifyQuery('How do I create an invoice?');
    expect(result.intent).toBe(INTENTS.HELP_QUERY);
    expect(result.routesToActionEngine).toBe(false);
  });

  test('does not route negated commands to the Action Engine', () => {
    const result = classifyQuery("Don't create a purchase order");
    expect(result.routesToActionEngine).toBe(false);
  });

  test('does not treat past-tense questions as action requests', () => {
    const result = classifyQuery('Did I create a purchase order yesterday?');
    expect(result.routesToActionEngine).toBe(false);
  });

  test('routes polite direct commands to the Action Engine', () => {
    const result = classifyQuery('Could you update this product?');
    expect(result.intent).toBe(INTENTS.ACTION_INTENT);
    expect(result.actionType).toBe(ACTION_TYPES.GENERIC_ACTION);
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
    expect(result.kpis).toEqual(expect.arrayContaining(['gross_margin_pct', 'vat_collected']));
    expect(result.domains).toContain('tax');
    expect(result.businessQuestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ requiredFacts: ['VAT collected for selected period'] }),
    ]));
  });

  test('flags ambiguous short followups for clarification', () => {
    const result = classifyQuery('do it');
    expect(result.intent).toBe(INTENTS.AMBIGUOUS_QUERY);
    expect(result.requiresClarification).toBe(true);
    expect(clarificationReply()).toContain('clarify');
  });

  test('builds an LLM fallback classifier prompt with recent conversation', () => {
    const messages = buildLLMClassificationMessages('it', [{ role: 'assistant', content: 'Sales are down.' }]);
    expect(messages[0].content).toContain('Classify the user');
    expect(messages).toContainEqual({ role: 'assistant', content: 'Sales are down.' });
  });

  test('validates and applies only whitelisted confident LLM classifications', () => {
    const base = classifyQuery('do it');
    const candidate = parseLLMClassification({
      intent: INTENTS.ACTION_INTENT,
      actionType: ACTION_TYPES.CREATE_PURCHASE_ORDER,
      confidence: 0.9,
      reason: 'The prior request was to create a purchase order.',
    });

    expect(candidate).not.toBeNull();
    expect(applyLLMClassification(base, candidate).routesToActionEngine).toBe(true);
    expect(parseLLMClassification({ intent: 'unknown', confidence: 0.99 })).toBeNull();
    expect(applyLLMClassification(base, { ...candidate, confidence: 0.4 })).toBe(base);
  });

  test('builds action proposal handoff copy', () => {
    const result = classifyQuery('Send payment reminder to overdue clients');
    const reply = actionProposalReply(result);
    expect(reply).toContain('action proposal');
    expect(reply).toContain('POST /api/ai/proposals');
    expect(reply).not.toContain('I sent');
  });
});
