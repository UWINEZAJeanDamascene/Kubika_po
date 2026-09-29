'use strict';

const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
const originalOpenRouterModel = process.env.OPENROUTER_MODEL;
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
delete process.env.OPENROUTER_MODEL;
jest.resetModules();

const { getConfiguredProviders } = require('../../../services/aiProviderService');

if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
if (originalOpenRouterModel === undefined) delete process.env.OPENROUTER_MODEL;
else process.env.OPENROUTER_MODEL = originalOpenRouterModel;

describe('OpenRouter provider configuration', () => {
  test('registers OpenRouter when openRouterApiKey is configured', () => {
    expect(getConfiguredProviders()).toEqual([
      expect.objectContaining({
        name: 'openrouter',
        displayName: 'OpenRouter',
        model: 'openrouter/free',
      }),
    ]);
  });
});