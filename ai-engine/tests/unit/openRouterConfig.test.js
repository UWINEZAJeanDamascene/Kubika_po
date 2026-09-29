'use strict';

const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
jest.resetModules();

const { getConfiguredProviders } = require('../../../services/aiProviderService');

if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;

describe('OpenRouter provider configuration', () => {
  test('registers OpenRouter when openRouterApiKey is configured', () => {
    expect(getConfiguredProviders()).toEqual([
      expect.objectContaining({
        name: 'openrouter',
        displayName: 'OpenRouter',
        model: 'openrouter/test-model',
      }),
    ]);
  });
});