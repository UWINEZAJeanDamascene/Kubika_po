'use strict';

const { createFact } = require('../../shared/factFactory');
const { AI_DOMAINS, FACT_TYPES } = require('../../shared/interfaces');
const {
  PROMPT_TEMPLATE_VERSION,
  serializeAIContext,
  buildChatMessages,
} = require('../../prompt-builder');
const {
  validateStructuredResponse,
  validateFreeTextResponse,
  parseAndValidateStructuredText,
} = require('../../guardrail');

function sampleFact() {
  return createFact({
    companyId: 'company_1',
    domain: AI_DOMAINS.SALES,
    label: 'Sales revenue for selected period',
    value: 1000,
    unit: 'RWF',
    sourceService: 'TestService',
    sourceMethod: 'fixture',
    sourceIds: ['invoice_1'],
    permissions: ['sales.read'],
    observedAt: '2026-08-05T09:00:00.000Z',
  });
}

describe('Prompt Builder and Guardrail', () => {
  test('serializes AIContext into grounded fact payloads', () => {
    const fact = sampleFact();
    const serialized = serializeAIContext({
      companyId: 'company_1',
      userId: 'user_1',
      facts: [fact],
      warnings: [],
      metadata: { requestId: 'req_1' },
    });

    expect(serialized.facts[0]).toEqual(expect.objectContaining({
      id: fact.id,
      label: 'Sales revenue for selected period',
      value: 1000,
    }));
    expect(serialized.metadata.requestId).toBe('req_1');
  });

  test('builds chat messages with versioned Stacy system prompt', () => {
    const messages = buildChatMessages({
      userName: 'Alice',
      companyName: 'Demo Ltd',
      history: [{ role: 'user', content: 'hello' }],
      userMessage: 'What are sales?',
    });

    expect(PROMPT_TEMPLATE_VERSION).toBe('stacy-system-v1');
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('Address Alice');
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'What are sales?' });
  });

  test('accepts structured FACT claims with known fact IDs', () => {
    const fact = sampleFact();
    const result = validateStructuredResponse({
      answer: 'Sales were RWF 1,000.',
      claimLabels: [{ text: 'Sales were RWF 1,000.', type: FACT_TYPES.FACT, factIds: [fact.id] }],
      missingData: [],
      recommendedActions: [],
    }, [fact]);

    expect(result.ok).toBe(true);
  });

  test('rejects FACT claims without evidence', () => {
    const result = validateStructuredResponse({
      answer: 'Sales were RWF 1,000.',
      claimLabels: [{ text: 'Sales were RWF 1,000.', type: FACT_TYPES.FACT, factIds: [] }],
      missingData: [],
      recommendedActions: [],
    }, []);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('FACT but has no factIds'),
    ]));
  });

  test('parses fenced JSON structured responses', () => {
    const fact = sampleFact();
    const result = parseAndValidateStructuredText(`\`\`\`json
{"answer":"ok","claimLabels":[{"text":"ok","type":"FACT","factIds":["${fact.id}"]}],"missingData":[],"recommendedActions":[]}
\`\`\``, [fact]);

    expect(result.ok).toBe(true);
    expect(result.parsed.answer).toBe('ok');
  });

  test('blocks unsafe free-text action completion claims', () => {
    const result = validateFreeTextResponse('I created the purchase order for you.');
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('business action');
  });
});

