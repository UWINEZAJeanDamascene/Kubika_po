'use strict';

jest.mock('../../../services/aiOperationalMetricsService', () => ({ recordEvent: jest.fn().mockResolvedValue(true) }));

const {
  CIRCUIT_STATES,
  _internal,
} = require('../../../services/aiProviderService');

function mockProvider(name, responseOrError, model = `${name}-model`) {
  const create = jest.fn(async () => {
    if (responseOrError instanceof Error) throw responseOrError;
    return responseOrError;
  });
  return {
    name,
    displayName: name,
    model,
    timeout: 1000,
    supportsJsonMode: true,
    client: { chat: { completions: { create } } },
    create,
  };
}

describe('LLM router internals', () => {
  beforeEach(() => {
    _internal.resetProviderCircuitState();
  });

  test('adds JSON response_format only when strictJson and provider supports it', () => {
    const provider = { supportsJsonMode: true };
    const payload = _internal.applyStructuredOutputParams(provider, { messages: [] }, { strictJson: true });
    expect(payload.response_format).toEqual({ type: 'json_object' });

    const noJson = _internal.applyStructuredOutputParams({ supportsJsonMode: false }, { messages: [] }, { strictJson: true });
    expect(noJson.response_format).toBeUndefined();

    const withTools = _internal.applyStructuredOutputParams(provider, { messages: [], tools: [{ type: 'function' }] }, { strictJson: true });
    expect(withTools.response_format).toBeUndefined();
  });

  test('strips router-only options before provider calls', () => {
    const { providerParams, routerOptions } = _internal.splitRouterOptions({
      messages: [],
      strictJson: true,
      validateResponse: () => ({ ok: true }),
      _routerOptions: { strictJson: false },
    });

    expect(providerParams.strictJson).toBeUndefined();
    expect(providerParams.validateResponse).toBeUndefined();
    expect(providerParams._routerOptions).toBeUndefined();
    expect(routerOptions.strictJson).toBe(true);
    expect(typeof routerOptions.validateResponse).toBe('function');
  });

  test('opens and closes provider circuit with metrics', () => {
    const error = new Error('rate limit');
    error.status = 429;

    _internal.markProviderFailure('groq', error, { openCircuit: true });
    let snapshot = _internal.getCircuitSnapshot('groq');
    expect(snapshot.state).toBe(CIRCUIT_STATES.OPEN);
    expect(snapshot.failures).toBe(1);

    _internal.markProviderSuccess('groq', 123);
    snapshot = _internal.getCircuitSnapshot('groq');
    expect(snapshot.state).toBe(CIRCUIT_STATES.CLOSED);
    expect(snapshot.successes).toBe(1);
    expect(snapshot.lastLatencyMs).toBe(123);
  });

  test('tracks guardrail rejection counts separately', () => {
    _internal.markProviderFailure('gemini', new Error('bad citations'), { guardrailRejected: true });
    const snapshot = _internal.getCircuitSnapshot('gemini');
    expect(snapshot.guardrailRejections).toBe(1);
    expect(snapshot.failures).toBe(1);
  });

  test('tracks rate limits and quota metadata', () => {
    const error = new Error('rate limit exceeded');
    error.status = 429;
    error.headers = { 'retry-after': '12', 'x-ratelimit-remaining-requests': '0' };

    _internal.markProviderFailure('limited', error);
    const snapshot = _internal.getCircuitSnapshot('limited');

    expect(snapshot.rateLimits).toBe(1);
    expect(snapshot.quota).toEqual(expect.objectContaining({
      'retry-after': '12',
      'x-ratelimit-remaining-requests': '0',
    }));
  });

  test('allows one half-open probe and reopens after a failed probe', () => {
    _internal.markProviderFailure('probe', new Error('initial failure'), { openCircuit: true, until: Date.now() - 1 });

    expect(_internal.acquireProvider('probe')).toBe(true);
    expect(_internal.getCircuitSnapshot('probe').state).toBe(CIRCUIT_STATES.HALF_OPEN);
    expect(_internal.acquireProvider('probe')).toBe(false);

    _internal.markProviderFailure('probe', new Error('probe failed'));
    expect(_internal.getCircuitSnapshot('probe').state).toBe(CIRCUIT_STATES.OPEN);
  });

  test('falls through to the next provider after an outage', async () => {
    const failed = mockProvider('outage', Object.assign(new Error('provider unavailable'), { status: 503 }));
    const healthy = mockProvider('healthy', { choices: [{ message: { content: '{"ok":true}' } }] });

    const response = await _internal.runProviderChain([failed, healthy], { messages: [] }, {});

    expect(failed.create).toHaveBeenCalledTimes(1);
    expect(healthy.create).toHaveBeenCalledTimes(1);
    expect(response.provider).toBe('healthy');
    expect(response.model).toBe('healthy-model');
  });

  test('falls through after malformed or rejected model output', async () => {
    const malformed = mockProvider('malformed', { choices: [{ message: { content: 'not json' } }] });
    const healthy = mockProvider('healthy', { choices: [{ message: { content: '{"ok":true}' } }] });
    const validateResponse = (result) => result.choices[0].message.content.startsWith('{')
      ? { ok: true }
      : { ok: false, errors: ['malformed JSON'] };

    const response = await _internal.runProviderChain([malformed, healthy], { messages: [] }, { validateResponse });

    expect(malformed.create).toHaveBeenCalledTimes(1);
    expect(healthy.create).toHaveBeenCalledTimes(1);
    expect(_internal.getCircuitSnapshot('malformed').guardrailRejections).toBe(1);
    expect(response.provider).toBe('healthy');
  });
});
