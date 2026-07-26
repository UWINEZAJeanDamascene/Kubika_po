const mongoose = require('mongoose');
const {
  incrementSequence,
  bumpSequence,
} = require('./postgresSequenceStore');
const { isMongoEnabled } = require('./transactionService');

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

  // When Mongo is still available, reconcile fixed_asset against existing docs
  // to avoid duplicate reference numbers left by prior test runs.
  if (name === 'fixed_asset' && isMongoEnabled()) {
    try {
      const coll = mongoose.connection.collection('fixedassets');
      const regex = `^AST-${year}-\\d{5}$`;

      let companyObjId;
      if (mongoose.Types.ObjectId.isValid(companyId)) {
        companyObjId = new mongoose.Types.ObjectId(companyId);
      } else {
        return padSeq(value);
      }

      const docs = await coll
        .find({ company: companyObjId, referenceNo: { $regex: regex } })
        .sort({ referenceNo: -1 })
        .limit(1)
        .toArray();

      const doc = docs?.[0];
      if (doc?.referenceNo) {
        const parts = doc.referenceNo.split('-');
        const maxNum = parseInt(parts[2], 10);
        if (!Number.isNaN(maxNum) && maxNum >= value) {
          value = await bumpSequence(companyId, name, year, maxNum - value + 1, options.tx || null);
        }
      }
    } catch (e) {
      console.warn(
        'sequenceService: fixed_asset seeding check failed',
        e && e.message ? e.message : e,
      );
    }
  }

  return padSeq(value);
}

module.exports = { nextSequence, nextGlobalSequence, padSeq };
