'use strict';

const {
  CIRCUIT_STATES,
  _internal,
} = require('../../../services/aiProviderService');

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
});

