'use strict';

const { buildTenantModel } = require('../utils/masterDataCommon');
const { generateObjectId, toIdString } = require('../utils/objectId');

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  companyId: { target: 'companyId', isId: true },
  importedBy: { target: 'importedBy', isId: true },
  templateUsed: { target: 'templateUsed', isId: true },
  entityType: { target: 'entityType' },
  startedAt: { target: 'startedAt' },
  completedAt: { target: 'completedAt' },
  totalRows: { target: 'totalRows' },
  successRows: { target: 'successRows' },
  errorRows: { target: 'errorRows' },
  skippedRows: { target: 'skippedRows' },
  errorReportUrl: { target: 'errorReportUrl' },
  resultsReportUrl: { target: 'resultsReportUrl' },
  fileName: { target: 'fileName' },
  jobId: { target: 'jobId' },
  rowOutcomes: { target: 'rowOutcomes' },
  errorMessage: { target: 'errorMessage' },
};

function toApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    companyId: row.companyId,
    entityType: row.entityType,
    importedBy: row.importedBy,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? null,
    status: row.status,
    totalRows: row.totalRows ?? 0,
    successRows: row.successRows ?? 0,
    errorRows: row.errorRows ?? 0,
    skippedRows: row.skippedRows ?? 0,
    templateUsed: row.templateUsed ?? null,
    errorReportUrl: row.errorReportUrl ?? null,
    resultsReportUrl: row.resultsReportUrl ?? null,
    fileName: row.fileName,
    jobId: row.jobId ?? null,
    rowOutcomes: row.rowOutcomes || [],
    errorMessage: row.errorMessage ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function translateCreate(data = {}) {
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    companyId: toIdString(data.companyId),
    entityType: data.entityType,
    importedBy: toIdString(data.importedBy),
    startedAt: data.startedAt || new Date(),
    completedAt: data.completedAt || null,
    status: data.status || 'pending',
    totalRows: data.totalRows || 0,
    successRows: data.successRows || 0,
    errorRows: data.errorRows || 0,
    skippedRows: data.skippedRows || 0,
    templateUsed: data.templateUsed ? toIdString(data.templateUsed) : null,
    errorReportUrl: data.errorReportUrl || null,
    resultsReportUrl: data.resultsReportUrl || null,
    fileName: data.fileName,
    jobId: data.jobId || null,
    rowOutcomes: data.rowOutcomes || [],
    errorMessage: data.errorMessage || null,
  };
}

function translateUpdate(update = {}) {
  const source = update.$set ? { ...update, ...update.$set } : { ...update };
  delete source.$set;
  delete source.$inc;
  delete source.$unset;
  const data = {};
  for (const field of ['companyId', 'entityType', 'startedAt', 'completedAt', 'status', 'totalRows', 'successRows', 'errorRows', 'skippedRows', 'errorReportUrl', 'resultsReportUrl', 'fileName', 'jobId', 'rowOutcomes', 'errorMessage']) {
    if (source[field] !== undefined) data[field] = field === 'companyId' ? toIdString(source[field]) : source[field];
  }
  for (const field of ['importedBy', 'templateUsed']) {
    if (source[field] !== undefined) data[field] = source[field] ? toIdString(source[field]) : null;
  }
  return data;
}

module.exports = buildTenantModel({
  name: 'ImportLog',
  collection: 'import_logs',
  delegateName: 'importLog',
  fieldMap: FIELD_MAP,
  toApi,
  translateCreate,
  translateUpdate,
  tenantField: 'companyId',
  mutable: true,
});
