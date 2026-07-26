const crypto = require('crypto');
const { decimalToNumber } = require('./decimalHelpers');

/**
 * Generate a 24-char hex id compatible with MongoDB ObjectId strings.
 * Used for PostgreSQL primary keys so the frontend can keep using `_id`.
 */
function generateObjectId() {
  return crypto.randomBytes(12).toString('hex');
}

function toIdString(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    // BSON / Mongoose ObjectId: _id getter returns self — use toString, not recurse
    if (value._bsontype === 'ObjectId' || value.constructor?.name === 'ObjectId') {
      return typeof value.toString === 'function' ? value.toString() : String(value);
    }
    if (value._id != null && value._id !== value) return toIdString(value._id);
    if (typeof value.id === 'string') return value.id;
  }
  if (typeof value.toString === 'function') {
    const s = value.toString();
    if (s && s !== '[object Object]') return s;
  }
  return String(value);
}

function toPlainJson(value) {
  if (value == null) return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(toPlainJson);
  if (typeof value === 'object') {
    if (value._bsontype === 'Decimal128' || value.constructor?.name === 'Decimal128') {
      return decimalToNumber(value);
    }
    if (value._bsontype === 'ObjectId' || value.constructor?.name === 'ObjectId') {
      return toIdString(value);
    }
    if (Buffer.isBuffer(value)) {
      return value.length === 12 ? value.toString('hex') : value.toString('base64');
    }
    if (value.buffer && Buffer.isBuffer(value.buffer)) {
      return value.buffer.length === 12 ? value.buffer.toString('hex') : toPlainJson(value.buffer);
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = toPlainJson(v);
    }
    return out;
  }
  return value;
}

module.exports = { generateObjectId, toIdString, toPlainJson };
