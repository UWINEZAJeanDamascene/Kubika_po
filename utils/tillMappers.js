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
    status: row.status,
    openingFloat: decimalToNumber(row.openingFloat, 0),
    closingCount: row.closingCount == null ? null : decimalToNumber(row.closingCount, 0),
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
    status: data.status || 'open',
    openingFloat: decimalToNumber(data.openingFloat, 0),
    closingCount: data.closingCount == null ? null : decimalToNumber(data.closingCount, 0),
    openedAt: data.openedAt ? new Date(data.openedAt) : undefined,
    closedAt: data.closedAt ? new Date(data.closedAt) : null,
  };
}

function tillSessionTranslateUpdate(update = {}) {
  const merged = mergeUpdatePayload(update);
  const out = {};
  if (merged.status !== undefined) out.status = merged.status;
  if (merged.openingFloat !== undefined) out.openingFloat = decimalToNumber(merged.openingFloat, 0);
  if (merged.closingCount !== undefined) {
    out.closingCount = merged.closingCount == null ? null : decimalToNumber(merged.closingCount, 0);
  }
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
