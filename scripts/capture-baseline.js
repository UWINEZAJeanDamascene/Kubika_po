#!/usr/bin/env node
/**
 * Capture a performance baseline from a running server.
 *
 *   node scripts/capture-baseline.js [--url http://localhost:3000] [--label before-phase4]
 *   node scripts/capture-baseline.js --top10
 *
 * Writes a timestamped JSON snapshot to performance-baselines/snapshots/ and
 * updates performance-baselines/manifest.json with the latest run metadata.
 *
 * WHAT MAKES A BASELINE MEANINGFUL
 *
 * With Redis configured, counters and rolling samples are retained for seven
 * days and aggregate across API replicas. Without Redis they intentionally fall
 * back to process-local samples and readiness fails outside tests unless that
 * mode is explicitly opted into. That means:
 *   - Compare like with like: the same routes exercised the same number of times
 *     against a similar data volume. A p95 over a few requests is noise.
 *   - Warm the server before comparing p95 values. A suspended Neon endpoint can
 *     take >10s to wake and will skew the maximum.
 *   - Treat `storage.aggregated_across_instances` as part of the baseline
 *     evidence, not an implementation detail.
 *
 * Recommended workflow for the top-10 endpoints:
 *   npm run perf:baseline:top10
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { endpoints: TOP_ENDPOINTS } = require('../config/topPerformanceEndpoints');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const baseUrl = arg('url', process.env.BASELINE_URL || 'http://localhost:3000');
const label = arg('label', process.argv.includes('--top10') ? 'top10' : 'baseline');
const outRoot = path.resolve(arg('output-dir', process.env.PERF_BASELINE_OUTPUT_DIR || path.join(__dirname, '..', 'performance-baselines')));
const outDir = path.join(outRoot, 'snapshots');
const manifestPath = path.join(outRoot, 'manifest.json');

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

function routeMatchesPattern(routeLabel, pattern) {
  if (!routeLabel || !pattern) return false;
  if (routeLabel === pattern) return true;
  // Allow parameterized routes: "GET /api/products/:id" matches pattern prefix.
  const routeParts = routeLabel.split(' ');
  const patternParts = pattern.split(' ');
  if (routeParts.length !== 2 || patternParts.length !== 2) return false;
  if (routeParts[0] !== patternParts[0]) return false;
  return routeParts[1] === patternParts[1] || routeParts[1].startsWith(`${patternParts[1]}/`);
}

function buildTopEndpointReport(allRoutes) {
  return TOP_ENDPOINTS.map((def) => {
    const match = (allRoutes || []).find((row) => routeMatchesPattern(row.route, def.routePattern));
    return {
      id: def.id,
      label: def.label,
      route_pattern: def.routePattern,
      warm_path: def.warmPath,
      target_p95_ms: def.targetP95Ms || null,
      sampled: Boolean(match && match.count > 0),
      count: match ? match.count : 0,
      p50_ms: match ? match.p50_ms : null,
      p95_ms: match ? match.p95_ms : null,
      p99_ms: match ? match.p99_ms : null,
      error_rate: match ? match.error_rate : null,
      slo_passed: Boolean(
        match
        && match.count > 0
        && (!def.targetP95Ms || match.p95_ms <= def.targetP95Ms)
        && match.error_rate === 0,
      ),
    };
  });
}

function updateManifest(entry) {
  let manifest = {
    description: 'Latest Phase 0 performance baselines for the top-10 API endpoints.',
    latest: null,
    history: [],
  };
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = { ...manifest, ...JSON.parse(fs.readFileSync(manifestPath, 'utf8')) };
    } catch {
      // overwrite corrupt manifest
    }
  }
  manifest.latest = entry;
  manifest.history = [entry, ...(manifest.history || [])].slice(0, 20);
  fs.mkdirSync(outRoot, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

(async () => {
  const url = `${baseUrl.replace(/\/$/, '')}/api/performance?limit=50`;
  console.log(`Capturing baseline from ${url}\n`);

  let data;
  try {
    // The metrics endpoint is recorded on response finish, so make one
    // preflight request and read the second response. This guarantees the
    // meta endpoint can sample itself even when capture runs without warm-up.
    await fetchJson(url);
    data = await fetchJson(url);
  } catch (e) {
    console.error(`Could not reach the server: ${e.message}`);
    console.error('Is it running, and is --url correct?');
    process.exit(1);
  }

  const r = data.requests || {};
  const routes = (data.routes && data.routes.routes) || [];
  const topEndpoints = buildTopEndpointReport(routes);
  const sampledCount = topEndpoints.filter((e) => e.sampled).length;
  const passingCount = topEndpoints.filter((e) => e.slo_passed).length;
  const baselineComplete = sampledCount === TOP_ENDPOINTS.length;

  if (!r.total_requests) {
    console.warn('WARNING: the server has served no requests since it started.');
    console.warn('This snapshot has nothing in it. Run npm run perf:warm-top10 first.\n');
  } else if (r.total_requests < 50) {
    console.warn(`WARNING: only ${r.total_requests} requests recorded — percentiles`);
    console.warn('over this few samples are noise. Treat this as indicative only.\n');
  }

  if (!baselineComplete) {
    console.error(`ERROR: only ${sampledCount}/${TOP_ENDPOINTS.length} top endpoints have samples.`);
    console.error('Run npm run perf:warm-top10 with PERF_BASELINE_TOKEN set, then re-capture.\n');
  }

  console.log('OVERALL');
  console.log(`  requests      ${r.total_requests}`);
  console.log(`  p50 / p95 / p99   ${r.p50_ms} / ${r.p95_ms} / ${r.p99_ms} ms   (max ${r.max_ms} ms)`);
  console.log(`  apdex         ${r.apdex} (T=${r.apdex_t_ms}ms)`);
  console.log(`  error rate    ${r.error_rate}%`);
  console.log(`  uptime        ${Math.round((data.uptime_seconds || 0) / 60)} min`);
  console.log(`  top-10        ${sampledCount}/${TOP_ENDPOINTS.length} sampled; ${passingCount}/${TOP_ENDPOINTS.length} SLO-compliant`);
  if (data.storage) {
    console.log(`  metrics store ${data.storage.backend} (${data.storage.aggregated_across_instances ? 'fleet aggregated' : 'process local'})`);
  }

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

  console.log('\nTOP 10 ENDPOINTS (Phase 0)');
  console.log(`  ${pad('endpoint', 22)} ${pad('n', 6)} ${pad('p50', 8)} ${pad('p95', 8)} ${pad('p99', 8)} ${pad('target', 8)} sampled SLO`);
  for (const row of topEndpoints) {
    console.log(
      `  ${pad(row.id, 22)} ${pad(row.count, 6)} ${pad(row.p50_ms ?? '-', 8)} ${pad(row.p95_ms ?? '-', 8)} ${pad(row.p99_ms ?? '-', 8)} ${pad(row.target_p95_ms ?? '-', 8)} ${row.sampled ? 'yes' : 'no'} ${row.slo_passed ? 'pass' : 'fail'}`,
    );
  }

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
  const fileName = `${label}-${stamp}.json`;
  const file = path.join(outDir, fileName);
  const snapshot = {
    label,
    captured_at: new Date().toISOString(),
    source: url,
    top_endpoints: topEndpoints,
    top_endpoints_sampled: sampledCount,
    top_endpoints_complete: baselineComplete,
    slo: {
      endpoints_passing: passingCount,
      endpoints_total: TOP_ENDPOINTS.length,
      all_endpoints_sampled: baselineComplete,
      all_endpoints_passing: passingCount === TOP_ENDPOINTS.length,
    },
    data,
  };
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));

  const manifestEntry = {
    label,
    captured_at: snapshot.captured_at,
    source: url,
    snapshot_file: path.join('snapshots', fileName).replace(/\\/g, '/'),
    overall: {
      total_requests: r.total_requests,
      p50_ms: r.p50_ms,
      p95_ms: r.p95_ms,
      p99_ms: r.p99_ms,
      apdex: r.apdex,
      cache_hit_ratio: cache.hit_ratio,
    },
    top_endpoints: topEndpoints,
    top_endpoints_sampled: sampledCount,
    top_endpoints_complete: baselineComplete,
    slo: {
      endpoints_passing: passingCount,
      endpoints_total: TOP_ENDPOINTS.length,
      all_endpoints_sampled: baselineComplete,
      all_endpoints_passing: passingCount === TOP_ENDPOINTS.length,
    },
  };
  updateManifest(manifestEntry);

  console.log(`\nSaved snapshot: ${path.relative(process.cwd(), file)}`);
  console.log(`Updated manifest: ${path.relative(process.cwd(), manifestPath)}`);
  if (!baselineComplete) process.exitCode = 1;
})();
