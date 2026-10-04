/**
 * Maps Prisma till_sessions rows to the legacy Mongoose JSON shape the POS
 * pages read (`openedBy`, plain numbers for the cash amounts).
 */

const { generateObjectId, toIdString } = require('./objectId');
const { decimalToNumber, idRef, mapTimestamps } = require('./decimalHelpers');
const { mergeUpdatePayload } = require('./masterDataMappers');

function tillSessionToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    company: row.companyId,
    openedBy: idRef(row.openedBy ?? row.openedById),
    openedById: row.openedById ?? (typeof row.openedBy === 'string' ? row.openedBy : row.openedBy?._id),
    registerId: row.registerId || 'legacy',
    registerName: row.registerName || 'Register',
    status: row.status,
    openingFloat: decimalToNumber(row.openingFloat, 0),
    expectedCash: decimalToNumber(row.expectedCash, row.openingFloat),
    closingCount: row.closingCount == null ? null : decimalToNumber(row.closingCount, 0),
    cashVariance: row.cashVariance == null ? null : decimalToNumber(row.cashVariance, 0),
    cashActivity: row.cashActivity || [],
    handoverFromId: row.handoverFromId || null,
    handoverToId: row.handoverToId || null,
    closeNotes: row.closeNotes || null,
    openedAt: row.openedAt,
    closedAt: row.closedAt ?? null,
    ...mapTimestamps(row),
  };
}

function tillSessionTranslateCreate(data = {}) {
  const openedBy = data.openedBy ?? data.openedById ?? data.opened_by;
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    companyId: toIdString(data.company ?? data.companyId ?? data.company_id),
    openedById: toIdString(openedBy),
    registerId: String(data.registerId || 'legacy').slice(0, 80),
    registerName: String(data.registerName || 'Register').slice(0, 120),
    status: data.status || 'open',
    openingFloat: decimalToNumber(data.openingFloat, 0),
    expectedCash: decimalToNumber(data.expectedCash ?? data.openingFloat, 0),
    closingCount: data.closingCount == null ? null : decimalToNumber(data.closingCount, 0),
    cashVariance: data.cashVariance == null ? null : decimalToNumber(data.cashVariance, 0),
    cashActivity: Array.isArray(data.cashActivity) ? data.cashActivity : [],
    handoverFromId: data.handoverFromId ? toIdString(data.handoverFromId) : null,
    handoverToId: data.handoverToId ? toIdString(data.handoverToId) : null,
    closeNotes: data.closeNotes || null,
    openedAt: data.openedAt ? new Date(data.openedAt) : undefined,
    closedAt: data.closedAt ? new Date(data.closedAt) : null,
  };
}

function tillSessionTranslateUpdate(update = {}) {
  const merged = mergeUpdatePayload(update);
  const out = {};
  if (merged.status !== undefined) out.status = merged.status;
  if (merged.registerId !== undefined) out.registerId = String(merged.registerId).slice(0, 80);
  if (merged.registerName !== undefined) out.registerName = String(merged.registerName).slice(0, 120);
  if (merged.openingFloat !== undefined) out.openingFloat = decimalToNumber(merged.openingFloat, 0);
  if (merged.expectedCash !== undefined) out.expectedCash = decimalToNumber(merged.expectedCash, 0);
  if (merged.closingCount !== undefined) {
    out.closingCount = merged.closingCount == null ? null : decimalToNumber(merged.closingCount, 0);
  }
  if (merged.cashVariance !== undefined) out.cashVariance = merged.cashVariance == null ? null : decimalToNumber(merged.cashVariance, 0);
  if (merged.cashActivity !== undefined) out.cashActivity = Array.isArray(merged.cashActivity) ? merged.cashActivity : [];
  if (merged.handoverFromId !== undefined) out.handoverFromId = merged.handoverFromId ? toIdString(merged.handoverFromId) : null;
  if (merged.handoverToId !== undefined) out.handoverToId = merged.handoverToId ? toIdString(merged.handoverToId) : null;
  if (merged.closeNotes !== undefined) out.closeNotes = merged.closeNotes || null;
  if (merged.openedAt !== undefined) out.openedAt = merged.openedAt ? new Date(merged.openedAt) : undefined;
  if (merged.closedAt !== undefined) out.closedAt = merged.closedAt ? new Date(merged.closedAt) : null;
  const openedBy = merged.openedBy ?? merged.openedById;
  if (openedBy !== undefined) out.openedById = toIdString(openedBy);
  return out;
}

module.exports = {
  tillSessionToApi,
  tillSessionTranslateCreate,
  tillSessionTranslateUpdate,
};
