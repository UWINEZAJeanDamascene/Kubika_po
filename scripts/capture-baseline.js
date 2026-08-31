#!/usr/bin/env node
/**
 * Capture a performance baseline from a running server.
 *
 *   node scripts/capture-baseline.js [--url http://localhost:3000] [--label before-phase4]
 *
 * Writes a timestamped JSON snapshot to performance-baselines/ and prints the
 * slowest routes. Run it twice — once before a change and once after, with the
 * same traffic pattern in between — and compare.
 *
 * WHAT MAKES A BASELINE MEANINGFUL
 *
 * Metrics are per-process and reset on restart, so a snapshot describes one
 * instance since it booted. That means:
 *   - Restart the server, use the app normally, then capture. A baseline taken
 *     seconds after boot describes almost nothing.
 *   - Compare like with like: the same routes exercised the same number of times
 *     against a similar data volume. A p95 over 3 requests is noise.
 *   - Ignore the first request after a cold start. A suspended Neon endpoint can
 *     take >10s to wake and will skew the maximum.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const baseUrl = arg('url', process.env.BASELINE_URL || 'http://localhost:3000');
const label = arg('label', 'baseline');
const outDir = path.join(__dirname, '..', 'performance-baselines');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 30000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Invalid JSON from ${url}: ${e.message}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Request timed out')); });
    req.on('error', reject);
  });
}

function pad(s, n) {
  return String(s).padEnd(n);
}

(async () => {
  const url = `${baseUrl.replace(/\/$/, '')}/api/performance?limit=50`;
  console.log(`Capturing baseline from ${url}\n`);

  let data;
  try {
    data = await fetchJson(url);
  } catch (e) {
    console.error(`Could not reach the server: ${e.message}`);
    console.error('Is it running, and is --url correct?');
    process.exit(1);
  }

  const r = data.requests || {};
  const routes = (data.routes && data.routes.routes) || [];

  if (!r.total_requests) {
    console.warn('WARNING: the server has served no requests since it started.');
    console.warn('This snapshot has nothing in it. Use the app first, then re-run.\n');
  } else if (r.total_requests < 50) {
    console.warn(`WARNING: only ${r.total_requests} requests recorded — percentiles`);
    console.warn('over this few samples are noise. Treat this as indicative only.\n');
  }

  console.log('OVERALL');
  console.log(`  requests      ${r.total_requests}`);
  console.log(`  p50 / p95 / p99   ${r.p50_ms} / ${r.p95_ms} / ${r.p99_ms} ms   (max ${r.max_ms} ms)`);
  console.log(`  apdex         ${r.apdex} (T=${r.apdex_t_ms}ms)`);
  console.log(`  error rate    ${r.error_rate}%`);
  console.log(`  uptime        ${Math.round((data.uptime_seconds || 0) / 60)} min`);

  const cache = data.cache || {};
  console.log('\nCACHE');
  console.log(`  hit ratio     ${cache.hit_ratio === null ? 'n/a (no lookups)' : cache.hit_ratio + '%'}`);
  console.log(`  hits/misses/errors  ${cache.hits}/${cache.misses}/${cache.errors}`);
  for (const t of (cache.by_type || []).slice(0, 8)) {
    console.log(`    ${pad(t.type, 22)} ${t.hit_ratio === null ? 'n/a' : t.hit_ratio + '%'}  (${t.hits}h/${t.misses}m)`);
  }

  const el = data.event_loop_lag || {};
  console.log('\nEVENT LOOP LAG');
  console.log(`  p50 / p95 / max   ${el.p50_ms} / ${el.p95_ms} / ${el.max_ms} ms`);

  console.log('\nSLOWEST ROUTES BY p95');
  if (!routes.length) {
    console.log('  (none recorded)');
  } else {
    console.log(`  ${pad('route', 46)} ${pad('n', 6)} ${pad('p50', 8)} ${pad('p95', 8)} ${pad('p99', 8)} err`);
    for (const row of routes.slice(0, 20)) {
      console.log(`  ${pad(row.route, 46)} ${pad(row.count, 6)} ${pad(row.p50_ms, 8)} ${pad(row.p95_ms, 8)} ${pad(row.p99_ms, 8)} ${row.error_rate}%`);
    }
  }
  if (data.routes && data.routes.truncated) {
    console.log('\n  NOTE: the route table is full; some routes are not being tracked.');
  }

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `${label}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ label, captured_at: new Date().toISOString(), source: url, data }, null, 2));
  console.log(`\nSaved: ${path.relative(process.cwd(), file)}`);
})();
