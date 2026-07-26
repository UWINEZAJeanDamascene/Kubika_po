const { Decimal } = require('@prisma/client/runtime/library');

function decimalToNumber(value, fallback = 0) {
  if (value == null) return fallback;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value) || fallback;
  if (value instanceof Decimal) return Number(value.toString());
  if (typeof value === 'object' && value.toString) return Number(value.toString()) || fallback;
  return Number(value) || fallback;
}

/** Match Mongoose Decimal128 JSON (string with fixed decimals). */
function decimalToString(value, decimals = 4) {
  const n = decimalToNumber(value, 0);
  return n.toFixed(decimals);
}

function idRef(value) {
  if (value == null) return null;
  if (typeof value === 'object' && value.id) return value.id;
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
}

function mapTimestamps(row) {
  return {
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

module.exports = { decimalToNumber, decimalToString, idRef, mapTimestamps };
