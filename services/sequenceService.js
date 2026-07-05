const Sequence = require('../models/Sequence');
const mongoose = require('mongoose');

// For certain sequence names (like fixed_asset) we need to ensure the
// sequence starts after any existing reference numbers already in the
// collection to avoid duplicate key errors when tests or previous runs
// left documents behind. We special-case 'fixed_asset' below.

function padSeq(n, digits = 5) {
  return String(n).padStart(digits, '0');
}


async function nextGlobalSequence(companyId, name, digits = 7) {
  const res = await Sequence.findOneAndUpdate(
    { company: companyId, name, year: 0 },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  return padSeq(res.seq, digits);
}
async function nextSequence(companyId, name) {
  const year = new Date().getFullYear();
  // Atomic upsert and increment
  const res = await Sequence.findOneAndUpdate(
    { company: companyId, name, year },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  // Special handling: if generating fixed_asset sequence, ensure we don't
  // collide with existing FixedAsset.referenceNo values (which can exist
  // from prior test runs). If the sequence result is 1 but there are
  // existing assets with higher numbers, bump the sequence atomically.
  if (name === 'fixed_asset') {
    try {
      // Use the raw collection to avoid requiring the FixedAsset model (circular
      // dependency with model's pre-save that calls this service). Query the
      // underlying collection for the highest referenceNo for this company/year.
      const coll = mongoose.connection.collection('fixedassets');
      const regex = `^AST-${year}-\\d{5}$`;

      // Safely convert companyId to ObjectId with validation
      let companyObjId;
      try {
        if (mongoose.Types.ObjectId.isValid(companyId)) {
          companyObjId = new mongoose.Types.ObjectId(companyId);
        } else {
          // Skip the fixed_asset check if companyId is not a valid ObjectId
          return padSeq(res.seq);
        }
      } catch (e) {
        // If conversion fails, skip the check
        return padSeq(res.seq);
      }

      const docs = await coll.find({
        company: companyObjId,
        referenceNo: { $regex: regex }
      }).sort({ referenceNo: -1 }).limit(1).toArray();

      const doc = docs && docs.length ? docs[0] : null;
      if (doc && doc.referenceNo) {
        const parts = doc.referenceNo.split('-');
        const maxNum = parseInt(parts[2], 10);
        if (!Number.isNaN(maxNum) && maxNum >= res.seq) {
          const bump = maxNum - res.seq + 1;
          const bumped = await Sequence.findOneAndUpdate(
            { company: companyId, name, year },
            { $inc: { seq: bump } },
            { new: true }
          ).lean();
          return padSeq(bumped.seq);
        }
      }
    } catch (e) {
      console.warn('sequenceService: fixed_asset seeding check failed', e && e.message ? e.message : e);
    }
  }

  return padSeq(res.seq);
}

module.exports = { nextSequence, nextGlobalSequence };

