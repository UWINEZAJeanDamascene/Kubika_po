/**
 * Atomic sequence counters on PostgreSQL (Step 8).
 * Uses INSERT … ON CONFLICT … RETURNING for race-safe increments inside
 * optional Prisma interactive transactions.
 */
const { prisma } = require('../lib/prisma');

const MAX_VSDC_NUMBER = 9999999999;

function client(tx) {
  return tx || prisma;
}

/**
 * Increment a (company, name, year) counter and return the new value.
 * @param {string} companyId
 * @param {string} name
 * @param {number} [year=0]
 * @param {import('@prisma/client').Prisma.TransactionClient} [tx]
 * @returns {Promise<number>}
 */
async function incrementSequence(companyId, name, year = 0, tx = null) {
  const rows = await client(tx).$queryRawUnsafe(
    `INSERT INTO sequences (company_id, name, year, value, created_at, updated_at)
     VALUES ($1, $2, $3, 1, NOW(), NOW())
     ON CONFLICT (company_id, name, year)
     DO UPDATE SET value = sequences.value + 1, updated_at = NOW()
     RETURNING value`,
    String(companyId),
    String(name),
    Number(year) || 0,
  );
  return Number(rows[0].value);
}

/**
 * Bump a counter by an arbitrary delta (e.g. fixed_asset seed reconciliation).
 * @param {string} companyId
 * @param {string} name
 * @param {number} year
 * @param {number} delta
 * @param {import('@prisma/client').Prisma.TransactionClient} [tx]
 * @returns {Promise<number>}
 */
async function bumpSequence(companyId, name, year, delta, tx = null) {
  const bump = Math.max(1, Number(delta) || 1);
  const rows = await client(tx).$queryRawUnsafe(
    `INSERT INTO sequences (company_id, name, year, value, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (company_id, name, year)
     DO UPDATE SET value = sequences.value + $4, updated_at = NOW()
     RETURNING value`,
    String(companyId),
    String(name),
    Number(year) || 0,
    bump,
  );
  return Number(rows[0].value);
}

/**
 * Read current counter value without incrementing.
 */
async function peekSequence(companyId, name, year = 0, tx = null) {
  const rows = await client(tx).$queryRawUnsafe(
    `SELECT value FROM sequences WHERE company_id = $1 AND name = $2 AND year = $3`,
    String(companyId),
    String(name),
    Number(year) || 0,
  );
  return rows.length ? Number(rows[0].value) : 0;
}

/**
 * Set counter to at least `minValue` (used when seeding from VSDC init info).
 */
async function ensureMinSequence(companyId, name, year, minValue, tx = null) {
  const min = Math.max(0, Number(minValue) || 0);
  const rows = await client(tx).$queryRawUnsafe(
    `INSERT INTO sequences (company_id, name, year, value, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (company_id, name, year)
     DO UPDATE SET value = GREATEST(sequences.value, EXCLUDED.value), updated_at = NOW()
     RETURNING value`,
    String(companyId),
    String(name),
    Number(year) || 0,
    min,
  );
  return Number(rows[0].value);
}

/**
 * Allocate the next EBM fiscal number for a branch + type.
 * @param {string} companyId
 * @param {string} branchId  two-char branch code
 * @param {string} sequenceType  EbmSequenceType enum value
 * @param {{ seed?: number, seededFrom?: string|null, tx?: object }} [options]
 * @returns {Promise<number>}
 */
async function allocateEbmSequence(companyId, branchId, sequenceType, options = {}) {
  const { seed = 0, seededFrom = null, tx = null } = options;
  const c = client(tx);
  const company = String(companyId);
  const branch = String(branchId).padStart(2, '0').slice(-2);
  const type = String(sequenceType);

  if (seed > 0) {
    await c.$queryRawUnsafe(
      `INSERT INTO ebm_sequences
         (company_id, branch_id, sequence_type, last_number, seeded_from, seeded_at, created_at, updated_at)
       VALUES ($1, $2, $3::"EbmSequenceType", $4, $5, NOW(), NOW(), NOW())
       ON CONFLICT (company_id, branch_id, sequence_type) DO NOTHING`,
      company,
      branch,
      type,
      Number(seed),
      seededFrom,
    );
  }

  const rows = await c.$queryRawUnsafe(
    `INSERT INTO ebm_sequences
       (company_id, branch_id, sequence_type, last_number, created_at, updated_at)
     VALUES ($1, $2, $3::"EbmSequenceType", 1, NOW(), NOW())
     ON CONFLICT (company_id, branch_id, sequence_type)
     DO UPDATE SET last_number = ebm_sequences.last_number + 1, updated_at = NOW()
     RETURNING last_number`,
    company,
    branch,
    type,
  );

  const lastNumber = Number(rows[0].last_number);
  if (lastNumber > MAX_VSDC_NUMBER) {
    const error = new Error(
      `EBM ${sequenceType} fiscal sequence exceeded VSDC NUMBER(10) capacity for branch ${branch}.`,
    );
    error.code = 'EBM_FISCAL_SEQUENCE_EXHAUSTED';
    error.retryable = false;
    throw error;
  }
  return lastNumber;
}

/**
 * Seed EBM counters from VSDC init info ($max semantics).
 */
async function seedEbmSequence(companyId, branchId, sequenceType, minValue, seededFrom = 'vsdc_init', tx = null) {
  const min = Math.max(0, Number(minValue) || 0);
  if (min <= 0) return min;

  const rows = await client(tx).$queryRawUnsafe(
    `INSERT INTO ebm_sequences
       (company_id, branch_id, sequence_type, last_number, seeded_from, seeded_at, created_at, updated_at)
     VALUES ($1, $2, $3::"EbmSequenceType", $4, $5, NOW(), NOW(), NOW())
     ON CONFLICT (company_id, branch_id, sequence_type)
     DO UPDATE SET
       last_number = GREATEST(ebm_sequences.last_number, EXCLUDED.last_number),
       seeded_from = EXCLUDED.seeded_from,
       seeded_at = NOW(),
       updated_at = NOW()
     RETURNING last_number`,
    String(companyId),
    String(branchId).padStart(2, '0').slice(-2),
    String(sequenceType),
    min,
    seededFrom,
  );
  return Number(rows[0].last_number);
}

module.exports = {
  MAX_VSDC_NUMBER,
  incrementSequence,
  bumpSequence,
  peekSequence,
  ensureMinSequence,
  allocateEbmSequence,
  seedEbmSequence,
};
