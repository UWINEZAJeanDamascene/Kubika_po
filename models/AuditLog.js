/**
 * AuditLog model — PostgreSQL (Prisma) backed.
 *
 * Built as a global model: tenant queries pass `company_id` explicitly and the
 * platform-wide queries deliberately span every tenant.
 */

const { buildGlobalModel } = require('../utils/masterDataCommon');
const {
  auditLogToApi,
  auditLogTranslateCreate,
  auditLogTranslateUpdate,
  auditLogInclude,
} = require('../utils/auditMappers');

const FIELD_MAP = {
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  company_id: { target: 'companyId', isId: true },
  user: { target: 'userId', isId: true },
  userId: { target: 'userId', isId: true },
  user_id: { target: 'userId', isId: true },
  action: { target: 'action' },
  entity_type: { target: 'entityType' },
  entityType: { target: 'entityType' },
  entity_id: { target: 'entityId' },
  entityId: { target: 'entityId' },
  changes: { target: 'changes' },
  ip_address: { target: 'ipAddress' },
  ipAddress: { target: 'ipAddress' },
  user_agent: { target: 'userAgent' },
  userAgent: { target: 'userAgent' },
  status: { target: 'status' },
  error_message: { target: 'errorMessage' },
  errorMessage: { target: 'errorMessage' },
  duration_ms: { target: 'durationMs' },
  durationMs: { target: 'durationMs' },
};

module.exports = buildGlobalModel({
  name: 'AuditLog',
  collection: 'auditlogs',
  delegateName: 'auditLog',
  fieldMap: FIELD_MAP,
  toApi: auditLogToApi,
  translateCreate: auditLogTranslateCreate,
  translateUpdate: auditLogTranslateUpdate,
  include: auditLogInclude,
});
