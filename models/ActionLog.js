/**
 * ActionLog model — PostgreSQL (Prisma) backed.
 *
 * Built as a global model: audit queries pass `company` explicitly, and the
 * platform admin screens intentionally read across every tenant.
 */

const { buildGlobalModel } = require('../utils/masterDataCommon');
const {
  actionLogToApi,
  actionLogTranslateCreate,
  actionLogTranslateUpdate,
  actionLogInclude,
} = require('../utils/auditMappers');

const FIELD_MAP = {
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  company_id: { target: 'companyId', isId: true },
  user: { target: 'userId', isId: true },
  userId: { target: 'userId', isId: true },
  user_id: { target: 'userId', isId: true },
  action: { target: 'action' },
  module: { target: 'module' },
  targetId: { target: 'targetId' },
  targetModel: { target: 'targetModel' },
  details: { target: 'details' },
  ipAddress: { target: 'ipAddress' },
  userAgent: { target: 'userAgent' },
  status: { target: 'status' },
};

module.exports = buildGlobalModel({
  name: 'ActionLog',
  collection: 'actionlogs',
  delegateName: 'actionLog',
  fieldMap: FIELD_MAP,
  toApi: actionLogToApi,
  translateCreate: actionLogTranslateCreate,
  translateUpdate: actionLogTranslateUpdate,
  include: actionLogInclude,
});
