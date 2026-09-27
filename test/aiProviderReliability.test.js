const { resolveAIModel } = require('../src/config/environment');
const aiProviderService = require('../services/aiProviderService');
const { getLocalWorkflowGuide } = require('../services/aiWorkflowGuideService');
const { classifyQuery } = require('../ai-engine/nlq');

describe('AI provider configuration and cooldowns', () => {
  afterEach(() => {
    aiProviderService._internal.resetProviderCircuitState();
    jest.restoreAllMocks();
  });

  test('replaces retired Groq and Gemini models but preserves supported overrides', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(resolveAIModel('groq', 'llama-3.1-8b-instant', 'openai/gpt-oss-20b'))
      .toBe('openai/gpt-oss-20b');
    expect(resolveAIModel('groq', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b'))
      .toBe('openai/gpt-oss-120b');
    expect(resolveAIModel('gemini', 'gemini-2.0-flash', 'gemini-3.5-flash-lite'))
      .toBe('gemini-3.5-flash-lite');
    expect(resolveAIModel('gemini', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'))
      .toBe('gemini-3.5-flash');
  });

  test.each([401, 402, 403, 404])('opens a cooldown circuit after provider status %s', (status) => {
    const name = `provider-${status}`;
    const error = Object.assign(new Error(`provider returned ${status}`), { status });

    aiProviderService._internal.markProviderFailure(name, error);

    const circuit = aiProviderService._internal.getCircuitSnapshot(name);
    expect(circuit.state).toBe(aiProviderService.CIRCUIT_STATES.OPEN);
    expect(circuit.lastStatus).toBe(status);
    expect(circuit.openedUntil).not.toBeNull();
    expect(aiProviderService._internal.acquireProvider(name)).toBe(false);
  });

  test('parses Retry-After from Fetch Headers objects', () => {
    const now = Date.now();
    const headers = { get: (name) => (name === 'retry-after' ? '8' : null) };

    const retryAt = aiProviderService._internal.parseRetryAfterFromError({ headers });

    expect(retryAt).toBeGreaterThanOrEqual(now + 7900);
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 8100);
  });

  test('answers invoice how-to questions without requiring an AI provider', () => {
    const question = 'How do I create and confirm an invoice?';
    expect(classifyQuery(question).intent).toBe('help_query');
    const reply = getLocalWorkflowGuide(question);

    expect(reply).toContain('choose New Invoice');
    expect(reply).toContain('choose Confirm');
    expect(reply).toContain('Record Payment');
  });

  test('leaves unrelated business questions to the AI provider router', () => {
    expect(getLocalWorkflowGuide('What were sales last month?')).toBeNull();
  });
});