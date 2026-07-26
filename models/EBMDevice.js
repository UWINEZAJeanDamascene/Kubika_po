/**
 * EBMDevice — PostgreSQL (Prisma) backed (global delegate, company stored on row).
 */

const { buildGlobalModel } = require('../utils/masterDataCommon');
const {
  ebmDeviceToApi,
  ebmDeviceTranslateCreate,
  ebmDeviceTranslateUpdate,
} = require('../utils/phase10Mappers');

const EBM_DEVICE_STATUSES = Object.freeze({
  NOT_INITIALIZED: 'not_initialized',
  INITIALIZED: 'initialized',
  FAILED: 'failed',
});

const EBM_DEVICE_MODES = Object.freeze({
  MOCK: 'mock',
  SANDBOX: 'sandbox',
  PRODUCTION: 'production',
});

const FIELD_MAP = {
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  tin: { target: 'tin' },
  branchId: { target: 'branchId' },
  branchName: { target: 'branchName' },
  deviceSerialNo: { target: 'deviceSerialNo' },
  status: { target: 'status' },
  initializedAt: { target: 'initializedAt' },
  lastAttemptAt: { target: 'lastAttemptAt' },
  initializedMode: { target: 'initializedMode' },
  lastAttemptMode: { target: 'lastAttemptMode' },
  branchRef: { target: 'branchRefId', isId: true },
  createdBy: { target: 'createdById', isId: true },
  updatedBy: { target: 'updatedById', isId: true },
};

const EBMDevice = buildGlobalModel({
  name: 'EBMDevice',
  collection: 'ebmdevices',
  delegateName: 'ebmDevice',
  fieldMap: FIELD_MAP,
  toApi: ebmDeviceToApi,
  translateCreate: ebmDeviceTranslateCreate,
  translateUpdate: ebmDeviceTranslateUpdate,
  mutable: true,
});

module.exports = EBMDevice;
module.exports.EBM_DEVICE_STATUSES = EBM_DEVICE_STATUSES;
module.exports.EBM_DEVICE_MODES = EBM_DEVICE_MODES;
