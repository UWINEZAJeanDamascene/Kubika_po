/**
 * AI Provider Service - Multi-provider LLM router with automatic fallback.
 *
 * Provider chain: Groq -> Gemini -> Mistral -> OpenRouter -> DeepSeek -> Together -> Ollama (local/dev).
 * The router owns provider health, circuit breaker state, structured-output hints,
 * provider/model metadata, and optional guardrail-driven fallback.
 */

const crypto = require('crypto');
const OpenAI = require('openai');
const env = require('../src/config/environment');
const config = env.getConfig();
const { redisClient, isRedisConfigured } = require('../config/redis');

const CACHE_TTL_SECONDS = config.ai.cacheTtlSeconds || 30;
const TIMEOUT_MS = config.ai.timeoutMs || 10000;
const HEALTHY_RETRY_MS = 60000;
const HEALTH_CHECK_TIMEOUT_MS = 3000;
const MAX_MEMORY_CACHE_SIZE = 500;
const MAX_LATENCY_SAMPLES = 25;

const CIRCUIT_STATES = Object.freeze({
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open',
});

const providerCircuits = new Map();
const memoryCache = new Map();

function nowIso() {
  return new Date().toISOString();
}

function createCircuit(name) {
  return {
    name,
    state: CIRCUIT_STATES.CLOSED,
    openedUntil: null,
    lastOpenedAt: null,
    lastHalfOpenAt: null,
    lastClosedAt: nowIso(),
    failures: 0,
    successes: 0,
    guardrailRejections: 0,
    lastError: null,
    lastLatencyMs: null,
    latencySamples: [],
    quota: null,
  };
}

function getCircuit(name) {
  if (!providerCircuits.has(name)) providerCircuits.set(name, createCircuit(name));
  const circuit = providerCircuits.get(name);
  if (circuit.state === CIRCUIT_STATES.OPEN && circuit.openedUntil && Date.now() > circuit.openedUntil) {
    circuit.state = CIRCUIT_STATES.HALF_OPEN;
    circuit.lastHalfOpenAt = nowIso();
  }
  return circuit;
}

function getCircuitSnapshot(name) {
  const circuit = getCircuit(name);
  const avgLatencyMs = circuit.latencySamples.length
    ? Math.round(circuit.latencySamples.reduce((sum, value) => sum + value, 0) / circuit.latencySamples.length)
    : null;
  return {
    state: circuit.state,
    openedUntil: circuit.openedUntil ? new Date(circuit.openedUntil).toISOString() : null,
    lastOpenedAt: circuit.lastOpenedAt,
    lastHalfOpenAt: circuit.lastHalfOpenAt,
    lastClosedAt: circuit.lastClosedAt,
    failures: circuit.failures,
    successes: circuit.successes,
    guardrailRejections: circuit.guardrailRejections,
    lastError: circuit.lastError,
    lastLatencyMs: circuit.lastLatencyMs,
    avgLatencyMs,
    quota: circuit.quota,
  };
}

function openCircuit(name, untilTimestampMs, reason) {
  const circuit = getCircuit(name);
  circuit.state = CIRCUIT_STATES.OPEN;
  circuit.openedUntil = untilTimestampMs || (Date.now() + HEALTHY_RETRY_MS);
  circuit.lastOpenedAt = nowIso();
  circuit.lastError = reason || circuit.lastError;
}

function closeCircuit(name) {
  const circuit = getCircuit(name);
  circuit.state = CIRCUIT_STATES.CLOSED;
  circuit.openedUntil = null;
  circuit.lastClosedAt = nowIso();
  circuit.lastError = null;
}

function markProviderSuccess(name, latencyMs) {
  const circuit = getCircuit(name);
  circuit.successes += 1;
  circuit.lastLatencyMs = latencyMs;
  if (typeof latencyMs === 'number') {
    circuit.latencySamples.push(latencyMs);
    if (circuit.latencySamples.length > MAX_LATENCY_SAMPLES) circuit.latencySamples.shift();
  }
  closeCircuit(name);
}

function markProviderFailure(name, err, opts = {}) {
  const circuit = getCircuit(name);
  circuit.failures += 1;
  circuit.lastError = err?.message || String(err || 'unknown error');
  if (opts.guardrailRejected) circuit.guardrailRejections += 1;

  const status = err?.status || err?.statusCode;
  const shouldOpen = opts.openCircuit || status === 429 || err?.name === 'AbortError' || /timeout|rate limit|quota/i.test(circuit.lastError);
  if (shouldOpen) {
    openCircuit(name, opts.until || parseRetryAfterFromError(err) || (Date.now() + HEALTHY_RETRY_MS), circuit.lastError);
  }
}

function isProviderHealthy(name) {
  return getCircuit(name).state !== CIRCUIT_STATES.OPEN;
}

function markProviderUnhealthy(name) {
  openCircuit(name, Date.now() + HEALTHY_RETRY_MS, 'manual unhealthy mark');
}

function markProviderUnhealthyUntil(name, untilTimestampMs) {
  openCircuit(name, untilTimestampMs, 'provider retry window');
}

function parseRetryAfterFromError(err) {
  try {
    const headers = err?.headers || err?.response?.headers || err?.rawHeaders;
    if (headers) {
      const raw = headers['retry-after'] || headers['Retry-After'] || headers['retry_after'];
      if (raw) {
        const secs = parseFloat(raw);
        if (!Number.isNaN(secs)) return Date.now() + Math.round(secs * 1000);
      }
    }

    const msg = err?.message || '';
    const m = msg.match(/in\s*((\d+)h)?\s*((\d+)m)?\s*((\d+(?:\.\d+)?)s)?/i);
    if (m) {
      const hours = parseInt(m[2] || '0', 10);
      const mins = parseInt(m[4] || '0', 10);
      const secs = parseFloat(m[6] || '0');
      const totalMs = ((hours * 3600) + (mins * 60) + secs) * 1000;
      if (totalMs > 0) return Date.now() + Math.round(totalMs);
    }
  } catch (e) {
    // ignore parsing errors
  }
  return null;
}

function providerMeta(name, displayName, client, model, timeout, opts = {}) {
  return {
    name,
    displayName,
    client,
    model,
    timeout,
    supportsJsonMode: opts.supportsJsonMode !== false,
    supportsToolCalling: opts.supportsToolCalling !== false,
    hosted: opts.hosted !== false,
  };
}

function createProviders() {
  const providers = [];
  const configured = [];
  const missing = [];

  if (config.ai.groqApiKey) {
    providers.push(providerMeta('groq', 'Groq', new OpenAI({
      apiKey: config.ai.groqApiKey,
      baseURL: config.ai.groqBaseUrl || 'https://api.groq.com/openai/v1',
    }), config.ai.groqModel || 'llama-3.1-8b-instant', Math.min(TIMEOUT_MS, 15000)));
    configured.push('groq');
  } else {
    missing.push('groq');
  }

  if (config.ai.geminiApiKey) {
    providers.push(providerMeta('gemini', 'Gemini', new OpenAI({
      apiKey: config.ai.geminiApiKey,
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    }), config.ai.geminiModel || 'gemini-2.0-flash', Math.min(TIMEOUT_MS, 20000)));
    configured.push('gemini');
  } else {
    missing.push('gemini');
  }

  if (config.ai.mistralApiKey) {
    providers.push(providerMeta('mistral', 'Mistral', new OpenAI({
      apiKey: config.ai.mistralApiKey,
      baseURL: config.ai.mistralBaseUrl || 'https://api.mistral.ai/v1',
    }), config.ai.mistralModel || 'mistral-small-latest', Math.min(TIMEOUT_MS, 20000)));
    configured.push('mistral');
  } else {
    missing.push('mistral');
  }

  if (config.ai.openrouterApiKey) {
    providers.push(providerMeta('openrouter', 'OpenRouter', new OpenAI({
      apiKey: config.ai.openrouterApiKey,
      baseURL: config.ai.openrouterBaseUrl || 'https://openrouter.ai/api/v1',
    }), config.ai.openrouterModel || 'openrouter/quasar-alpha', Math.min(TIMEOUT_MS, 20000)));
    configured.push('openrouter');
  } else {
    missing.push('openrouter');
  }

  if (config.ai.deepseekApiKey) {
    providers.push(providerMeta('deepseek', 'DeepSeek', new OpenAI({
      apiKey: config.ai.deepseekApiKey,
      baseURL: config.ai.deepseekBaseUrl || 'https://api.deepseek.com/v1',
    }), config.ai.deepseekModel || 'deepseek-chat', Math.min(TIMEOUT_MS, 20000)));
    configured.push('deepseek');
  } else {
    missing.push('deepseek');
  }

  if (config.ai.togetherApiKey) {
    providers.push(providerMeta('together', 'Together', new OpenAI({
      apiKey: config.ai.togetherApiKey,
      baseURL: config.ai.togetherBaseUrl || 'https://api.together.xyz/v1',
    }), config.ai.togetherModel || 'meta-llama/Llama-3.2-3B-Instruct-Turbo', Math.min(TIMEOUT_MS, 20000)));
    configured.push('together');
  } else {
    missing.push('together');
  }

  if (config.ai.ollamaBaseUrl) {
    const ollamaBase = config.ai.ollamaBaseUrl;
    const isLocalhost = /(^https?:\/\/)?(localhost|127\.0\.0\.1|::1)/i.test(ollamaBase);
    if (isLocalhost && process.env.NODE_ENV === 'production') {
      console.warn('[AI] OLLAMA_BASE_URL points to localhost but running in production - skipping Ollama provider.');
    } else {
      providers.push(providerMeta('ollama', 'Ollama', new OpenAI({
        apiKey: 'ollama',
        baseURL: config.ai.ollamaBaseUrl,
      }), config.ai.ollamaModel || 'llama3.2', Math.max(TIMEOUT_MS, 30000), {
        supportsJsonMode: false,
        hosted: false,
      }));
    }
  }

  console.log(`[AI Providers] Configured: ${configured.join(', ') || 'none'}`);
  if (missing.length) console.log(`[AI Providers] Missing API keys: ${missing.join(', ')}`);

  return providers;
}

async function checkProviderHealth(provider) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

  try {
    if (provider.name === 'ollama') {
      const baseURL = provider.client.baseURL || config.ai.ollamaBaseUrl;
      const resp = await fetch(`${baseURL.replace(/\/$/, '')}/models`, {
        signal: controller.signal,
        headers: { Authorization: 'Bearer ollama' },
      });
      clearTimeout(timer);
      return resp.ok;
    }

    clearTimeout(timer);
    return true;
  } catch (err) {
    clearTimeout(timer);
    return false;
  }
}

function getProviders() {
  return createProviders().filter((p) => isProviderHealthy(p.name));
}

function cleanupMemoryCache(force = false) {
  const now = Date.now();
  for (const [key, entry] of memoryCache) {
    if (entry.expires < now) memoryCache.delete(key);
  }
  if (force || memoryCache.size > MAX_MEMORY_CACHE_SIZE) {
    const overage = memoryCache.size - MAX_MEMORY_CACHE_SIZE;
    const keysToDelete = Array.from(memoryCache.keys()).slice(0, Math.max(0, overage + 50));
    for (const key of keysToDelete) memoryCache.delete(key);
  }
}

const cacheCleanupTimer = setInterval(() => cleanupMemoryCache(true), 5 * 60 * 1000);
cacheCleanupTimer.unref && cacheCleanupTimer.unref();

function makeCacheKey(systemPrompt, messages) {
  const payload = JSON.stringify({ system: systemPrompt, messages });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

async function getCachedResponse(cacheKey) {
  if (isRedisConfigured() && redisClient) {
    try {
      const val = await redisClient.get(`ai:response:${cacheKey}`);
      if (val) {
        const parsed = JSON.parse(val);
        return { ...parsed, cached: true, provider: parsed.provider || 'cache' };
      }
    } catch (e) {
      // Redis error - fall through to memory cache.
    }
  }

  const entry = memoryCache.get(cacheKey);
  if (entry && entry.expires > Date.now()) {
    return { ...entry.data, cached: true, provider: entry.data.provider || 'cache' };
  }
  return null;
}

async function setCachedResponse(cacheKey, response) {
  const payload = { reply: response.reply, provider: response.provider, metadata: response.metadata || null };
  if (isRedisConfigured() && redisClient) {
    try {
      if (typeof redisClient.setex === 'function') {
        await redisClient.setex(`ai:response:${cacheKey}`, CACHE_TTL_SECONDS, JSON.stringify(payload));
      } else if (typeof redisClient.setEx === 'function') {
        await redisClient.setEx(`ai:response:${cacheKey}`, CACHE_TTL_SECONDS, JSON.stringify(payload));
      } else if (typeof redisClient.set === 'function') {
        await redisClient.set(`ai:response:${cacheKey}`, JSON.stringify(payload), { ex: CACHE_TTL_SECONDS });
      }
      return;
    } catch (e) {
      // Redis error - fall through to memory cache.
    }
  }

  cleanupMemoryCache();
  memoryCache.set(cacheKey, { data: payload, expires: Date.now() + CACHE_TTL_SECONDS * 1000 });
}

function splitRouterOptions(requestParams = {}) {
  const {
    _routerOptions = {},
    strictJson,
    validateResponse,
    ...providerParams
  } = requestParams;

  return {
    providerParams,
    routerOptions: {
      ..._routerOptions,
      strictJson: Boolean(_routerOptions.strictJson || strictJson),
      validateResponse: _routerOptions.validateResponse || validateResponse || null,
    },
  };
}

function applyStructuredOutputParams(provider, requestParams, routerOptions) {
  const payload = { ...requestParams };
  if (routerOptions.strictJson && provider.supportsJsonMode && !payload.response_format) {
    payload.response_format = { type: 'json_object' };
  }
  return payload;
}

async function callProviderRaw(provider, requestParams, routerOptions = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), provider.timeout);

  try {
    const providerPayload = applyStructuredOutputParams(provider, requestParams, routerOptions);
    const result = await provider.client.chat.completions.create(
      {
        ...providerPayload,
        model: provider.model,
      },
      { signal: controller.signal }
    );
    clearTimeout(timer);
    return {
      result,
      provider: provider.name,
      displayName: provider.displayName,
      model: provider.model,
      metadata: {
        provider: provider.name,
        displayName: provider.displayName,
        model: provider.model,
        supportsJsonMode: provider.supportsJsonMode,
      },
    };
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

async function callProviderWithRetry(provider, requestParams, opts = {}) {
  const maxRetries = opts.maxRetries ?? 2;
  let attempt = 0;
  let delay = 1000;

  while (attempt <= maxRetries) {
    try {
      return await callProviderRaw(provider, requestParams, opts.routerOptions || {});
    } catch (err) {
      attempt += 1;
      const status = err?.status || err?.statusCode || 'no-status';

      if (status === 429) {
        const until = parseRetryAfterFromError(err) || (Date.now() + HEALTHY_RETRY_MS);
        markProviderFailure(provider.name, err, { until, openCircuit: true });
        throw err;
      }

      const isAbort = err.name === 'AbortError' || /timeout|aborted/i.test(err.message || '');
      if (attempt > maxRetries || !isAbort) {
        markProviderFailure(provider.name, err, { openCircuit: isAbort });
        throw err;
      }

      await new Promise((res) => setTimeout(res, delay));
      delay *= 2;
    }
  }

  throw new Error('Provider retries exhausted');
}

function validateRouterResponse(response, routerOptions, provider) {
  if (typeof routerOptions.validateResponse !== 'function') return { ok: true };
  const validation = routerOptions.validateResponse(response.result, {
    provider: provider.name,
    model: provider.model,
    displayName: provider.displayName,
  });
  if (validation && validation.ok === false) return validation;
  return { ok: true, ...(validation || {}) };
}

function isConfigured() {
  return createProviders().length > 0;
}

function getConfiguredProviders() {
  return createProviders().map((p) => ({
    name: p.name,
    displayName: p.displayName,
    model: p.model,
    supportsJsonMode: p.supportsJsonMode,
    circuit: getCircuitSnapshot(p.name),
  }));
}

async function createCompletion(params) {
  let lastError = null;
  const { providerParams, routerOptions } = splitRouterOptions(params);
  const allConfigured = createProviders();
  const activeProviders = getProviders();

  if (allConfigured.length === 0) {
    throw new Error('No AI providers are configured. Set GROQ_API_KEY, GEMINI_API_KEY, or OLLAMA_BASE_URL environment variables.');
  }

  if (activeProviders.length === 0) {
    const error = new Error('All configured AI providers are temporarily unhealthy. Please try again in a minute.');
    error.allProvidersFailed = true;
    throw error;
  }

  console.log(`[createCompletion] Starting with ${activeProviders.length} active providers: ${activeProviders.map(p => p.name).join(', ')}`);

  for (const provider of activeProviders) {
    console.log(`[createCompletion] Trying provider: ${provider.name}`);
    try {
      const start = Date.now();
      const response = await callProviderWithRetry(provider, providerParams, { maxRetries: 2, routerOptions });
      const elapsed = Date.now() - start;
      const validation = validateRouterResponse(response, routerOptions, provider);
      if (!validation.ok) {
        const validationError = new Error(`Guardrail rejected provider output: ${(validation.errors || []).join('; ') || 'invalid output'}`);
        markProviderFailure(provider.name, validationError, { guardrailRejected: true });
        lastError = validationError;
        console.warn(`AI provider ${provider.name} output failed guardrail. Trying next...`);
        continue;
      }

      markProviderSuccess(provider.name, elapsed);
      if (elapsed > 8000) console.warn(`Provider ${provider.name} responded slowly (${elapsed}ms)`);
      return {
        ...response,
        metadata: {
          ...response.metadata,
          latencyMs: elapsed,
          circuit: getCircuitSnapshot(provider.name),
          strictJson: routerOptions.strictJson,
          validation,
        },
      };
    } catch (err) {
      lastError = err;
      const reason = err.name === 'AbortError' ? 'timeout' : (err.message || 'unknown');
      const status = err.status || err.statusCode || 'no-status';
      console.warn(`AI provider ${provider.name} failed (status=${status}, reason=${reason}, type=${err.type || 'n/a'}). Trying next...`);
    }
  }

  const error = new Error(`All AI providers failed. Last error: ${lastError?.message || 'Unknown error'}`);
  error.allProvidersFailed = true;
  throw error;
}

async function cachedChatCompletion(systemPrompt, messages, completionParams) {
  const cacheKey = makeCacheKey(systemPrompt, messages);
  const cached = await getCachedResponse(cacheKey);
  if (cached) {
    return { reply: cached.reply, provider: cached.provider, cached: true, metadata: cached.metadata || null };
  }

  const { result, provider, displayName, metadata } = await createCompletion(completionParams);
  const reply = result.choices?.[0]?.message?.content || '';
  const response = { reply, provider: displayName || provider, cached: false, metadata };

  await setCachedResponse(cacheKey, response);
  return response;
}

async function getProviderStatus() {
  const all = createProviders();
  const statuses = await Promise.all(
    all.map(async (p) => {
      const healthy = await checkProviderHealth(p);
      if (!healthy && isProviderHealthy(p.name)) markProviderUnhealthy(p.name);
      return {
        name: p.name,
        displayName: p.displayName,
        model: p.model,
        configured: true,
        healthy,
        reachable: isProviderHealthy(p.name) && healthy,
        supportsJsonMode: p.supportsJsonMode,
        supportsToolCalling: p.supportsToolCalling,
        hosted: p.hosted,
        circuit: getCircuitSnapshot(p.name),
      };
    })
  );
  return statuses;
}

function resetProviderCircuitState() {
  providerCircuits.clear();
}

const configured = createProviders();
console.log(`[AI] Provider config: groq=${config.ai.groqApiKey ? 'set' : 'missing'}, gemini=${config.ai.geminiApiKey ? 'set' : 'missing'}, ollama=${config.ai.ollamaBaseUrl ? 'set' : 'missing'}`);
console.log(`[AI] Active providers: ${configured.map(p => p.name).join(', ') || 'NONE'}`);

module.exports = {
  CIRCUIT_STATES,
  isConfigured,
  getConfiguredProviders,
  getProviderStatus,
  createCompletion,
  cachedChatCompletion,
  // Exported for focused tests and operational diagnostics.
  _internal: {
    applyStructuredOutputParams,
    splitRouterOptions,
    getCircuit,
    getCircuitSnapshot,
    markProviderFailure,
    markProviderSuccess,
    resetProviderCircuitState,
    parseRetryAfterFromError,
  },
};
