'use strict';

const { buildTenantModel } = require('../utils/masterDataCommon');
const { generateObjectId, toIdString } = require('../utils/objectId');

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  companyId: { target: 'companyId', isId: true },
  createdBy: { target: 'createdBy', isId: true },
  entityType: { target: 'entityType' },
  columnMapping: { target: 'columnMapping' },
  lastUsedAt: { target: 'lastUsedAt' },
  useCount: { target: 'useCount' },
};

function toApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    companyId: row.companyId,
    entityType: row.entityType,
    name: row.name,
    columnMapping: row.columnMapping || {},
    createdBy: row.createdBy,
    lastUsedAt: row.lastUsedAt ?? null,
    useCount: row.useCount ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function translateCreate(data = {}) {
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    companyId: toIdString(data.companyId),
    entityType: data.entityType,
    name: data.name,
    columnMapping: data.columnMapping || {},
    createdBy: toIdString(data.createdBy),
    lastUsedAt: data.lastUsedAt || null,
    useCount: data.useCount || 0,
  };
}

function translateUpdate(update = {}) {
  const source = update.$set ? { ...update, ...update.$set } : { ...update };
  delete source.$set;
  delete source.$inc;
  delete source.$unset;
  const data = {};
  for (const field of ['companyId', 'entityType', 'name', 'columnMapping', 'lastUsedAt', 'useCount']) {
    if (source[field] !== undefined) data[field] = field === 'companyId' ? toIdString(source[field]) : source[field];
  }
  if (source.createdBy !== undefined) data.createdBy = toIdString(source.createdBy);
  return data;
}

module.exports = buildTenantModel({
  name: 'ImportTemplate',
  collection: 'import_templates',
  delegateName: 'importTemplate',
  fieldMap: FIELD_MAP,
  toApi,
  translateCreate,
  translateUpdate,
  tenantField: 'companyId',
  mutable: true,
});
