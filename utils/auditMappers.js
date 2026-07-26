/**
 * Maps Prisma audit rows (action_logs, audit_logs) to the legacy Mongoose JSON
 * shapes the audit trail, login history, and platform admin screens consume.
 */

const { generateObjectId, toIdString } = require('./objectId');
const { mergeUpdatePayload } = require('./masterDataMappers');

function relation(row, key, mapper) {
  const value = row[key];
  if (value && typeof value === 'object') return mapper(value);
  return value ?? null;
}

function userRef(user) {
  if (!user) return null;
  return {
    _id: user.id,
    id: user.id,
    name: user.name,
    email: user.email,
  };
}

function companyRef(company) {
  if (!company) return null;
  return {
    _id: company.id,
    id: company.id,
    name: company.name,
    code: company.code,
  };
}

function actionLogToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    company: relation(row, 'company', companyRef) ?? row.companyId ?? null,
    user: relation(row, 'user', userRef) ?? row.userId ?? null,
    action: row.action,
    module: row.module,
    targetId: row.targetId ?? null,
    targetModel: row.targetModel ?? null,
    details: row.details ?? {},
    ipAddress: row.ipAddress ?? null,
    userAgent: row.userAgent ?? null,
    status: row.status ?? 'success',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const ACTION_LOG_FIELDS = {
  action: 'action',
  module: 'module',
  targetId: 'targetId',
  targetModel: 'targetModel',
  details: 'details',
  ipAddress: 'ipAddress',
  userAgent: 'userAgent',
  status: 'status',
};

function actionLogTranslateCreate(data = {}) {
  const companyId = data.company ?? data.companyId ?? data.company_id ?? null;
  const userId = data.user ?? data.userId ?? data.user_id ?? null;
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    companyId: companyId ? toIdString(companyId) : null,
    userId: userId ? toIdString(userId) : null,
    action: String(data.action || ''),
    module: String(data.module || 'report'),
    targetId: data.targetId ? String(toIdString(data.targetId) || data.targetId) : null,
    targetModel: data.targetModel ?? null,
    details: data.details ?? {},
    ipAddress: data.ipAddress ?? null,
    userAgent: data.userAgent ?? null,
    status: data.status || 'success',
    createdAt: data.createdAt || undefined,
  };
}

function actionLogTranslateUpdate(update = {}) {
  const merged = mergeUpdatePayload(update);
  const out = {};
  for (const [key, target] of Object.entries(ACTION_LOG_FIELDS)) {
    if (merged[key] !== undefined) out[target] = merged[key];
  }
  const companyId = merged.company ?? merged.companyId;
  if (companyId !== undefined) out.companyId = companyId ? toIdString(companyId) : null;
  const userId = merged.user ?? merged.userId;
  if (userId !== undefined) out.userId = userId ? toIdString(userId) : null;
  return out;
}

/** `populate('user')` / `populate('company')` on the audit trail queries. */
function actionLogInclude(populate = []) {
  const paths = (populate || []).map((p) => String(p.path || p || ''));
  const include = {};
  if (paths.some((p) => p === 'user' || p === 'user_id' || p === 'userId')) include.user = true;
  if (paths.some((p) => p === 'company' || p === 'company_id' || p === 'companyId')) include.company = true;
  return Object.keys(include).length ? include : undefined;
}

/** Legacy AuditLog documents are snake_case, unlike ActionLog. */
function auditLogToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    company_id: relation(row, 'company', companyRef) ?? row.companyId ?? null,
    user_id: relation(row, 'user', userRef) ?? row.userId ?? null,
    action: row.action,
    entity_type: row.entityType,
    entity_id: row.entityId ?? null,
    changes: row.changes ?? null,
    ip_address: row.ipAddress ?? null,
    user_agent: row.userAgent ?? null,
    status: row.status ?? 'success',
    error_message: row.errorMessage ?? null,
    duration_ms: row.durationMs ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const AUDIT_LOG_FIELDS = {
  action: 'action',
  entity_type: 'entityType',
  entityType: 'entityType',
  entity_id: 'entityId',
  entityId: 'entityId',
  changes: 'changes',
  ip_address: 'ipAddress',
  ipAddress: 'ipAddress',
  user_agent: 'userAgent',
  userAgent: 'userAgent',
  status: 'status',
  error_message: 'errorMessage',
  errorMessage: 'errorMessage',
  duration_ms: 'durationMs',
  durationMs: 'durationMs',
};

function auditLogTranslateCreate(data = {}) {
  const companyId = data.company_id ?? data.companyId ?? data.company ?? null;
  const userId = data.user_id ?? data.userId ?? data.user ?? null;
  const entityId = data.entity_id ?? data.entityId ?? null;
  const durationMs = data.duration_ms ?? data.durationMs ?? null;
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    companyId: companyId ? toIdString(companyId) : null,
    userId: userId ? toIdString(userId) : null,
    action: String(data.action || ''),
    entityType: String(data.entity_type ?? data.entityType ?? ''),
    entityId: entityId == null ? null : String(entityId),
    changes: data.changes ?? null,
    ipAddress: data.ip_address ?? data.ipAddress ?? null,
    userAgent: data.user_agent ?? data.userAgent ?? null,
    status: data.status || 'success',
    errorMessage: data.error_message ?? data.errorMessage ?? null,
    durationMs: durationMs == null ? null : Math.trunc(Number(durationMs)) || 0,
    createdAt: data.createdAt || undefined,
  };
}

function auditLogTranslateUpdate(update = {}) {
  const merged = mergeUpdatePayload(update);
  const out = {};
  for (const [key, target] of Object.entries(AUDIT_LOG_FIELDS)) {
    if (merged[key] !== undefined) out[target] = merged[key];
  }
  const companyId = merged.company_id ?? merged.companyId;
  if (companyId !== undefined) out.companyId = companyId ? toIdString(companyId) : null;
  const userId = merged.user_id ?? merged.userId;
  if (userId !== undefined) out.userId = userId ? toIdString(userId) : null;
  if (out.entityId != null) out.entityId = String(out.entityId);
  return out;
}

function auditLogInclude(populate = []) {
  const paths = (populate || []).map((p) => String(p.path || p || ''));
  const include = {};
  if (paths.some((p) => p === 'user_id' || p === 'user' || p === 'userId')) include.user = true;
  if (paths.some((p) => p === 'company_id' || p === 'company' || p === 'companyId')) include.company = true;
  return Object.keys(include).length ? include : undefined;
}

module.exports = {
  actionLogToApi,
  actionLogTranslateCreate,
  actionLogTranslateUpdate,
  actionLogInclude,
  auditLogToApi,
  auditLogTranslateCreate,
  auditLogTranslateUpdate,
  auditLogInclude,
};
