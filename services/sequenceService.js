const { incrementSequence } = require('./postgresSequenceStore');

function padSeq(n, digits = 5) {
  return String(n).padStart(digits, '0');
}

/**
 * Next global (year=0) sequence value, padded.
 */
async function nextGlobalSequence(companyId, name, digits = 7, options = {}) {
  const value = await incrementSequence(companyId, name, 0, options.tx || null);
  return padSeq(value, digits);
}

/**
 * Next year-scoped sequence value, padded (e.g. INV-2026-00001).
 * Backed by PostgreSQL `sequences` table (Step 8).
 */
async function nextSequence(companyId, name, options = {}) {
  const year = options.year ?? new Date().getFullYear();
  let value = await incrementSequence(companyId, name, year, options.tx || null);

  return padSeq(value);
}

module.exports = { nextSequence, nextGlobalSequence, padSeq };
