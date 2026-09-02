#!/usr/bin/env node
/**
 * Warm the Phase 0 top-10 endpoints so capture-baseline has meaningful samples.
 *
 *   npm run perf:warm-top10
 *
 * Auth (pick one):
 *   PERF_BASELINE_TOKEN=<jwt>
 *   PERF_BASELINE_EMAIL + PERF_BASELINE_PASSWORD
 *
 * Without credentials, only public endpoints (/api/performance) are warmed.
 */

require('dotenv').config();

const http = require('http');
const https = require('https');
const { endpoints } = require('../config/topPerformanceEndpoints');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const baseUrl = arg('url', process.env.BASELINE_URL || 'http://localhost:3000').replace(/\/$/, '');
const iterations = Math.max(1, Number(arg('iterations', process.env.PERF_WARM_ITERATIONS || 5)) || 5);

function request(method, url, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const parsed = new URL(url);
    const opts = {
      method,
      hostname: parsed.hostname,
      port: parsed.port || (url.startsWith('https') ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      headers,
      timeout: 60000,
    };
    const req = client.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => { req.destroy(new Error(`Timeout: ${method} ${url}`)); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function resolveAuthToken() {
  if (process.env.PERF_BASELINE_TOKEN) return process.env.PERF_BASELINE_TOKEN;

  const email = process.env.PERF_BASELINE_EMAIL;
  const password = process.env.PERF_BASELINE_PASSWORD;
  if (!email || !password) return null;

  const res = await request(
    'POST',
    `${baseUrl}/api/auth/login`,
    { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify({ email, password })) },
    JSON.stringify({ email, password }),
  );
  if (res.status !== 200) {
    throw new Error(`Login failed (HTTP ${res.status}): ${res.body.slice(0, 200)}`);
  }
  const payload = JSON.parse(res.body);
  const token = payload.token || payload.data?.token || payload.accessToken;
  if (!token) throw new Error('Login succeeded but no token found in response.');
  return token;
}

async function warmOnce(token) {
  const results = [];
  for (const endpoint of endpoints) {
    if (!endpoint.public && !token) {
      results.push({ id: endpoint.id, skipped: true, reason: 'no auth' });
      continue;
    }
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const url = `${baseUrl}${endpoint.warmPath}`;
    const start = Date.now();
    try {
      const res = await request('GET', url, headers);
      results.push({
        id: endpoint.id,
        status: res.status,
        duration_ms: Date.now() - start,
        ok: res.status >= 200 && res.status < 400,
      });
    } catch (error) {
      results.push({
        id: endpoint.id,
        ok: false,
        duration_ms: Date.now() - start,
        error: error.message,
      });
    }
  }
  return results;
}

(async () => {
  console.log(`Warming top ${endpoints.length} endpoints on ${baseUrl} (${iterations} iteration(s))\n`);

  let token = null;
  try {
    token = await resolveAuthToken();
  } catch (error) {
    console.error(`Auth failed: ${error.message}`);
    console.error(error); // Add full error for debugging
    process.exit(1);
  }

  if (!token) {
    console.warn('No PERF_BASELINE_TOKEN or PERF_BASELINE_EMAIL/PASSWORD — warming public endpoints only.\n');
  }

  let failures = 0;
  for (let i = 0; i < iterations; i += 1) {
    const batch = await warmOnce(token);
    for (const row of batch) {
      if (row.skipped) {
        console.log(`  [skip] ${row.id} (${row.reason})`);
        continue;
      }
      const tag = row.ok ? ' ok ' : 'FAIL';
      console.log(`  [${tag}] ${row.id}  ${row.status || '-'}  ${row.duration_ms}ms${row.error ? `  ${row.error}` : ''}`);
      if (!row.ok) failures += 1;
    }
    if (i < iterations - 1) console.log('');
  }

  if (failures > 0) {
    console.error(`\n${failures} warm request(s) failed. Fix auth or server errors before capturing a baseline.`);
    process.exit(1);
  }

  console.log('\nWarm-up complete. Run: npm run perf:baseline:top10');
})();
