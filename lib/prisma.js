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

function createClient() {
  const client = new PrismaClient({
    log: (process.env.PRISMA_LOG || 'warn').split(',').filter(Boolean),
    datasources: {
      db: {
        url: process.env.DATABASE_URL,
      },
    },
  });

  return client.$extends({
    query: {
      async $allOperations({ operation, args, query }) {
        const start = Date.now();
        for (let attempt = 1; ; attempt += 1) {
          try {
            const result = await query(args);
            const duration = Date.now() - start;
            if (duration > 1000) {
              console.warn(
                `[Prisma SLOW QUERY] ${operation} took ${duration}ms`,
              );
            }
            return result;
          } catch (error) {
            const duration = Date.now() - start;
            if (duration > 1000) {
              console.warn(
                `[Prisma SLOW QUERY] ${operation} took ${duration}ms (failed)`,
              );
            }
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

module.exports = { prisma, connectPrisma, disconnectPrisma, warmPrisma };
