'use strict';

const crypto = require('crypto');
const { redisClient, isRedisConfigured } = require('../../config/redis');
const { AI_DOMAINS, assertValidAIContext } = require('../shared/interfaces');
const { enrichContextWithKpis } = require('../knowledge-model');
const { collectors, byDomain } = require('./collectors');
const {
  extractUserPermissions,
  filterFactsForPermissions,
  hasPermission,
  normalizeCompanyId,
} = require('./permissionUtils');

const CACHE_TTL_SECONDS = 120;
const memoryCache = new Map();
const MAX_MEMORY_CACHE_SIZE = 200;

const DOMAIN_KEYWORDS = Object.freeze({
  [AI_DOMAINS.SALES]: ['sale', 'sales', 'revenue', 'invoice', 'customer order', 'pos'],
  [AI_DOMAINS.INVENTORY]: ['stock', 'inventory', 'product', 'sku', 'warehouse', 'low stock', 'out of stock'],
  [AI_DOMAINS.FINANCE]: ['cash', 'bank', 'profit', 'loss', 'expense', 'finance', 'margin', 'payable', 'receivable'],
  [AI_DOMAINS.PURCHASES]: ['purchase', 'supplier invoice', 'procurement', 'grn', 'goods received'],
  [AI_DOMAINS.CUSTOMERS]: ['client', 'customer', 'receivable', 'aging', 'owed', 'overdue'],
  [AI_DOMAINS.SUPPLIERS]: ['supplier', 'vendor'],
  [AI_DOMAINS.PAYROLL]: ['payroll', 'salary', 'employee', 'timesheet'],
  [AI_DOMAINS.REPORTS]: ['report', 'ratio', 'balance sheet', 'cash flow', 'p&l', 'trial balance'],
});

function stableHash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

function cleanupMemoryCache() {
  const now = Date.now();
  for (const [key, entry] of memoryCache) {
    if (entry.expiresAt <= now) memoryCache.delete(key);
  }
  if (memoryCache.size > MAX_MEMORY_CACHE_SIZE) {
    const extra = memoryCache.size - MAX_MEMORY_CACHE_SIZE;
    for (const key of Array.from(memoryCache.keys()).slice(0, extra + 20)) {
      memoryCache.delete(key);
    }
  }
}

function normalizeDomains(domains, query) {
  const explicit = Array.isArray(domains)
    ? domains.map((domain) => String(domain).toLowerCase().trim()).filter(Boolean)
    : [];
  const validExplicit = explicit.filter((domain) => byDomain.has(domain));
  if (validExplicit.length) return Array.from(new Set(validExplicit));

  const text = String(query || '').toLowerCase();
  const inferred = [];
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    if (keywords.some((keyword) => text.includes(keyword))) inferred.push(domain);
  }

  if (inferred.length) return Array.from(new Set(inferred));

  return [
    AI_DOMAINS.SALES,
    AI_DOMAINS.INVENTORY,
    AI_DOMAINS.FINANCE,
    AI_DOMAINS.CUSTOMERS,
    AI_DOMAINS.PURCHASES,
  ];
}

function normalizeDateRange(dateRange = {}) {
  const from = dateRange && dateRange.from ? String(dateRange.from) : undefined;
  const to = dateRange && dateRange.to ? String(dateRange.to) : undefined;
  return { from, to };
}

function normalizeKpiIds(kpis = []) {
  return Array.isArray(kpis) ? kpis.map((kpi) => String(kpi).trim()).filter(Boolean) : [];
}

function makeCacheKey({ companyId, userId, permissions, query, domains, dateRange, kpis }) {
  return `ai:context:${stableHash({
    companyId,
    userId,
    permissions: [...permissions].sort(),
    query: String(query || '').slice(0, 300),
    domains,
    dateRange,
    kpis,
  })}`;
}

async function getCachedContext(cacheKey) {
  if (isRedisConfigured() && redisClient) {
    try {
      const raw = await redisClient.get(cacheKey);
      if (raw) return { context: JSON.parse(raw), cacheHit: true, cacheLayer: 'redis' };
    } catch (error) {
      // Fall through to memory cache.
    }
  }

  const entry = memoryCache.get(cacheKey);
  if (entry && entry.expiresAt > Date.now()) {
    return { context: entry.value, cacheHit: true, cacheLayer: 'memory' };
  }

  return null;
}

async function setCachedContext(cacheKey, context) {
  if (isRedisConfigured() && redisClient) {
    try {
      const payload = JSON.stringify(context);
      if (typeof redisClient.setex === 'function') {
        await redisClient.setex(cacheKey, CACHE_TTL_SECONDS, payload);
      } else if (typeof redisClient.setEx === 'function') {
        await redisClient.setEx(cacheKey, CACHE_TTL_SECONDS, payload);
      } else if (typeof redisClient.set === 'function') {
        await redisClient.set(cacheKey, payload, { ex: CACHE_TTL_SECONDS });
      }
      return;
    } catch (error) {
      // Fall through to memory cache.
    }
  }

  cleanupMemoryCache();
  memoryCache.set(cacheKey, {
    value: context,
    expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000,
  });
}

function collectorAllowed(collector, userPermissions) {
  return hasPermission(userPermissions, collector.requiredPermissions || []);
}

async function buildContext({ user, company, query = '', domains, dateRange = {}, kpis = [], requestId }) {
  const companyId = normalizeCompanyId(company || user?.company);
  const userId = normalizeCompanyId(user);

  if (!companyId) {
    throw new Error('Company context is required for AI context building.');
  }
  if (!userId) {
    throw new Error('User context is required for AI context building.');
  }

  const userPermissions = extractUserPermissions(user);
  const selectedDomains = normalizeDomains(domains, query);
  const normalizedDateRange = normalizeDateRange(dateRange);
  const selectedKpis = normalizeKpiIds(kpis);
  const cacheKey = makeCacheKey({
    companyId,
    userId,
    permissions: userPermissions,
    query,
    domains: selectedDomains,
    dateRange: normalizedDateRange,
    kpis: selectedKpis,
  });

  const cached = await getCachedContext(cacheKey);
  if (cached) {
    cached.context.metadata = {
      ...cached.context.metadata,
      cache: { hit: true, layer: cached.cacheLayer, key: cacheKey },
    };
    return cached.context;
  }

  const facts = [];
  const warnings = [];
  const collectorSummaries = [];

  for (const domain of selectedDomains) {
    const collector = byDomain.get(domain);
    if (!collector) {
      warnings.push(`No context collector registered for domain '${domain}'.`);
      continue;
    }

    if (!collectorAllowed(collector, userPermissions)) {
      warnings.push(`Skipped '${domain}' context because the user lacks a required read permission.`);
      collectorSummaries.push({ domain, status: 'skipped_permission' });
      continue;
    }

    try {
      const startedAt = Date.now();
      const result = await collector.collect({
        companyId,
        userId,
        user,
        query,
        dateRange: normalizedDateRange,
      });
      const rawFacts = Array.isArray(result.facts) ? result.facts : [];
      const permittedFacts = filterFactsForPermissions(rawFacts, userPermissions);
      facts.push(...permittedFacts);
      warnings.push(...(result.warnings || []));
      collectorSummaries.push({
        domain,
        status: 'ok',
        facts: permittedFacts.length,
        filteredFacts: rawFacts.length - permittedFacts.length,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      warnings.push(`Collector '${domain}' failed: ${error.message}`);
      collectorSummaries.push({ domain, status: 'failed', error: error.message });
    }
  }

  const context = {
    companyId,
    userId,
    permissions: userPermissions,
    facts,
    warnings,
    metadata: {
      requestId: requestId || null,
      query: String(query || ''),
      domains: selectedDomains,
      dateRange: normalizedDateRange,
      generatedAt: new Date().toISOString(),
      factCount: facts.length,
      collectors: collectorSummaries,
      cache: { hit: false, layer: null, key: cacheKey, ttlSeconds: CACHE_TTL_SECONDS },
      availableDomains: collectors.map((collector) => collector.domain),
      requestedKpis: selectedKpis,
    },
  };

  const finalContext = selectedKpis.length ? enrichContextWithKpis(context, selectedKpis) : context;
  assertValidAIContext(finalContext);
  await setCachedContext(cacheKey, finalContext);
  return finalContext;
}

module.exports = {
  buildContext,
  normalizeDomains,
  normalizeDateRange,
  normalizeKpiIds,
  makeCacheKey,
};
