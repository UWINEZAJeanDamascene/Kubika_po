const SLOW_THRESHOLD_MS = Number(process.env.SLOW_QUERY_THRESHOLD_MS || 1000);
const LOG_THRESHOLD_MS = Number(process.env.LOG_THRESHOLD_MS || 500);

class SlowQueryMonitor {
  constructor() {
    this.slowQueries = [];
    this.maxEntries = 1000;
  }

  record(operation, durationMs, query, params) {
    if (durationMs >= SLOW_THRESHOLD_MS) {
      const entry = {
        operation,
        durationMs,
        query: query?.substring?.(0, 500) || '',
        params: this.sanitizeParams(params),
        timestamp: new Date().toISOString(),
      };
      this.slowQueries.push(entry);
      if (this.slowQueries.length > this.maxEntries) {
        this.slowQueries.shift();
      }
      console.warn(
        `[SlowQuery] ${operation} took ${durationMs}ms`,
        entry.query ? `query: ${entry.query}` : '',
      );
    } else if (durationMs >= LOG_THRESHOLD_MS) {
      console.log(
        `[Query] ${operation} took ${durationMs}ms`,
      );
    }
  }

  sanitizeParams(params) {
    if (!params) return undefined;
    if (typeof params === 'string') return params.substring(0, 200);
    if (typeof params === 'object') {
      try {
        return JSON.stringify(params).substring(0, 500);
      } catch {
        return '[object]';
      }
    }
    return params;
  }

  getSlowQueries(limit = 50) {
    return this.slowQueries.slice(-limit);
  }

  getStats() {
    const count = this.slowQueries.length;
    if (count === 0) return { totalQueries: count, avgDurationMs: 0, maxDurationMs: 0 };
    const durations = this.slowQueries.map((e) => e.durationMs);
    return {
      totalQueries: count,
      avgDurationMs: Math.round(durations.reduce((a, b) => a + b, 0) / count),
      maxDurationMs: Math.max(...durations),
      minDurationMs: Math.min(...durations),
    };
  }

  reset() {
    this.slowQueries = [];
  }
}

const monitor = new SlowQueryMonitor();
module.exports = monitor;