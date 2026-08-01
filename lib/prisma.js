const { PrismaClient } = require('@prisma/client');

const globalForPrisma = globalThis;

/**
 * Neon suspends idle compute, so the first query after a quiet spell can outlast
 * Prisma's connect timeout (P1001) or land on a connection the pooler already
 * closed (P1017/P2024). P1001/P1002 mean the engine never reached the server, so
 * retrying cannot double-apply anything; the other codes can surface after the
 * statement was sent, so those are only retried for reads.
 */
const READ_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  '$queryRaw',
  '$queryRawUnsafe',
]);

/** Misconfiguration rather than an unreachable server — retrying cannot help. */
const FATAL_INIT_CODES = new Set(['P1000', 'P1003', 'P1012', 'P1013']);

const MAX_ATTEMPTS = Math.max(1, Number(process.env.PRISMA_RETRY_ATTEMPTS || 3));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(error, operation) {
  if (!error) return false;
  // The engine never established a connection, so no statement was executed.
  if (error.name === 'PrismaClientInitializationError') return !FATAL_INIT_CODES.has(error.errorCode);
  const code = error.code || error.errorCode;
  if (code === 'P1001' || code === 'P1002') return true;
  if (code === 'P1017' || code === 'P2024') return READ_OPERATIONS.has(operation);
  return false;
}

/**
 * Neon can take a while to accept a TCP connection while its compute resumes
 * from suspend. Without an explicit connect/pool timeout, the underlying pg
 * driver falls back to the OS default TCP timeout (which can run ~2 minutes
 * on some networks) before Prisma even gets a chance to retry. Forcing a
 * short timeout here means a cold endpoint fails fast and our own retry loop
 * (below) takes over instead of the request appearing to hang.
 */
function withConnectionTimeouts(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('connect_timeout')) {
      parsed.searchParams.set('connect_timeout', process.env.PRISMA_CONNECT_TIMEOUT || '10');
    }
    if (!parsed.searchParams.has('pool_timeout')) {
      parsed.searchParams.set('pool_timeout', process.env.PRISMA_POOL_TIMEOUT || '10');
    }
    return parsed.toString();
  } catch (_) {
    return url;
  }
}

function createClient() {
  const datasourceUrl = withConnectionTimeouts(process.env.DATABASE_URL);
  const client = new PrismaClient({
    log: (process.env.PRISMA_LOG || 'warn').split(',').filter(Boolean),
    ...(datasourceUrl ? { datasources: { db: { url: datasourceUrl } } } : {}),
  });

  return client.$extends({
    query: {
      async $allOperations({ operation, args, query }) {
        for (let attempt = 1; ; attempt += 1) {
          try {
            return await query(args);
          } catch (error) {
            if (attempt >= MAX_ATTEMPTS || !isRetryable(error, operation)) throw error;
            console.warn(
              `[Prisma] ${error.code || error.errorCode || error.name} on ${operation}`
              + ` — retrying (${attempt}/${MAX_ATTEMPTS - 1})`,
            );
            await sleep(attempt * 400);
          }
        }
      },
    },
  });
}

const prisma = globalForPrisma.__stockPrisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__stockPrisma = prisma;
}

async function connectPrisma() {
  if (!process.env.DATABASE_URL) {
    console.warn('[Prisma] DATABASE_URL not set — PostgreSQL client not connected');
    return false;
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      await prisma.$connect();
      console.log('PostgreSQL connected via Prisma');
      return true;
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isRetryable(error, '$connect')) throw error;
      console.warn(
        `[Prisma] connect failed (${error.code || error.errorCode || error.name})`
        + ` — retrying (${attempt}/${MAX_ATTEMPTS - 1})`,
      );
      await sleep(attempt * 1000);
    }
  }
}

async function disconnectPrisma() {
  try {
    await prisma.$disconnect();
  } catch (_) {
    /* ignore */
  }
}

/** Run a lightweight query so the first real request (e.g. login) does not pay Neon wake-up cost. */
async function warmPrisma() {
  if (!process.env.DATABASE_URL) return false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    console.log('[Prisma] Connection warmed');
    return true;
  } catch (error) {
    console.warn('[Prisma] Warm-up query failed:', error.message || error);
    return false;
  }
}

let keepAliveTimer = null;

/**
 * Ping the database periodically so Neon's compute never gets a chance to
 * autosuspend while the server process is alive. This avoids cold-start
 * latency on the *next* user request entirely, rather than just failing
 * fast when it happens. Default interval is under Neon's default 5-minute
 * autosuspend window.
 */
function startPrismaKeepAlive(intervalMs = Number(process.env.PRISMA_KEEPALIVE_MS || 4 * 60 * 1000)) {
  if (!process.env.DATABASE_URL || keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    warmPrisma().catch(() => {});
  }, intervalMs);
  if (typeof keepAliveTimer.unref === 'function') keepAliveTimer.unref();
}

function stopPrismaKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

module.exports = {
  prisma,
  connectPrisma,
  disconnectPrisma,
  warmPrisma,
  startPrismaKeepAlive,
  stopPrismaKeepAlive,
};
