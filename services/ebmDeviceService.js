const EBMDevice = require('../models/EBMDevice');
const Company = require('../models/Company');
const Warehouse = require('../models/Warehouse');
const ebmService = require('./ebmService');
const { EBM_DEVICE_STATUSES } = require('../models/EBMDevice');
const { EBM_MODES, EBMServiceError, extractInitInfo } = require('./ebmService');
const EBMFiscalSequenceService = require('./ebmFiscalSequenceService');

function normalizeBranchId(value) {
  if (value === undefined || value === null || value === '') return null;
  const digits = String(value).trim();
  return digits.padStart(2, '0').slice(-2);
}

function extractTin(company) {
  return String(
    company?.tax_identification_number ||
    company?.registration_number ||
    company?.tin ||
    '',
  ).trim();
}

function buildDeviceSerialNo({ tin, branchId }) {
  return `dvc${tin}${branchId}`;
}

function toPublicDevice(device) {
  if (!device) return null;
  const raw = typeof device.toObject === 'function' ? device.toObject() : device;
  return {
    _id: raw._id,
    company: raw.company,
    tin: raw.tin,
    branchId: raw.branchId,
    branchName: raw.branchName,
    branchRef: raw.branchRef,
    deviceSerialNo: raw.deviceSerialNo,
    status: raw.status,
    initializedAt: raw.initializedAt,
    lastAttemptAt: raw.lastAttemptAt,
    lastErrorMessage: raw.lastErrorMessage,
    initializedMode: raw.initializedMode,
    lastAttemptMode: raw.lastAttemptMode,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

class EBMDeviceService {
  static normalizeBranchId = normalizeBranchId;

  static async getCompany(companyId) {
    const company = await Company.findById(companyId).lean();
    if (!company) {
      const error = new Error('Company not found');
      error.statusCode = 404;
      throw error;
    }
    return company;
  }

  static async getBranchRows(companyId) {
    const warehouses = await Warehouse.find({ company: companyId, isActive: { $ne: false } })
      .sort({ isDefault: -1, createdAt: 1, name: 1 })
      .lean();

    if (!warehouses.length) {
      return [{
        branchId: '00',
        branchName: 'Headquarter',
        branchRef: null,
      }];
    }

    return warehouses.map((warehouse) => ({
      branchId: warehouse.rraBranchId || (warehouse.isDefault ? '00' : null),
      branchName: warehouse.name || warehouse.code || `Branch ${warehouse.rraBranchId || '00'}`,
      branchRef: warehouse._id,
      rraBranchId: warehouse.rraBranchId || null,
    })).filter((branch) => branch.branchId);
  }

  static async getInitializationStatus(companyId) {
    const [company, branches, devices] = await Promise.all([
      this.getCompany(companyId),
      this.getBranchRows(companyId),
      EBMDevice.find({ company: companyId }).lean(),
    ]);

    const tin = extractTin(company);
    const currentMode = ebmService.getConfig().mode;
    const deviceByBranch = new Map(devices.map((device) => [device.branchId, device]));

    return {
      mode: currentMode,
      tin,
      branches: branches.map((branch) => {
        const device = deviceByBranch.get(branch.branchId);
        return {
          ...branch,
          tin,
          deviceSerialNo: device?.deviceSerialNo || (tin ? buildDeviceSerialNo({ tin, branchId: branch.branchId }) : null),
          status: device?.status || EBM_DEVICE_STATUSES.NOT_INITIALIZED,
          initializedAt: device?.initializedAt || null,
          lastAttemptAt: device?.lastAttemptAt || null,
          lastErrorMessage: device?.lastErrorMessage || null,
          initializedMode: device?.initializedMode || null,
          lastAttemptMode: device?.lastAttemptMode || null,
          modeMatches: device?.status === EBM_DEVICE_STATUSES.INITIALIZED && device?.initializedMode === currentMode,
          recordId: device?._id || null,
        };
      }),
    };
  }

  static async ensureInitialized({ companyId, branchId, mode }) {
    const normalizedBranchId = normalizeBranchId(branchId);
    if (!companyId) {
      throw new EBMServiceError('Company context is required before calling VSDC.', {
        code: 'EBM_COMPANY_CONTEXT_REQUIRED',
        mode,
        retryable: false,
      });
    }
    if (!normalizedBranchId) {
      throw new EBMServiceError('Branch ID is required before calling VSDC.', {
        code: 'EBM_BRANCH_CONTEXT_REQUIRED',
        mode,
        retryable: false,
      });
    }

    const device = await EBMDevice.findOne({
      company: companyId,
      branchId: normalizedBranchId,
      status: EBM_DEVICE_STATUSES.INITIALIZED,
      initializedMode: mode,
    }).lean();

    if (!device) {
      throw new EBMServiceError(
        `EBM device is not initialized for company ${companyId}, branch ${normalizedBranchId}, mode ${mode}. Run device initialization before making VSDC calls.`,
        {
          code: 'EBM_DEVICE_NOT_INITIALIZED',
          mode,
          retryable: false,
        },
      );
    }

    return device;
  }

  static async initializeDevice(companyId, data = {}, userId = null) {
    const company = await this.getCompany(companyId);
    const tin = String(data.tin || extractTin(company)).trim();
    const branchId = normalizeBranchId(data.branchId || data.bhfId || '00');

    if (!tin) {
      const error = new Error('Company TIN is required before EBM device initialization.');
      error.statusCode = 422;
      throw error;
    }

    const branches = await this.getBranchRows(companyId);
    const branch = branches.find((candidate) => candidate.branchId === branchId) || {
      branchId,
      branchName: branchId === '00' ? 'Headquarter' : `Branch ${branchId}`,
      branchRef: null,
    };

    let device = await EBMDevice.findOne({ company: companyId, branchId });
    const requestedSerialNo = String(data.deviceSerialNo || data.dvcSrlNo || device?.deviceSerialNo || buildDeviceSerialNo({ tin, branchId })).trim();

    if (device && device.deviceSerialNo !== requestedSerialNo) {
      const error = new Error('Device serial number is immutable once set for an EBM branch device.');
      error.statusCode = 409;
      throw error;
    }

    if (!device) {
      device = await EBMDevice.create({
        company: companyId,
        tin,
        branchId,
        branchName: branch.branchName,
        branchRef: branch.branchRef,
        deviceSerialNo: requestedSerialNo,
        status: EBM_DEVICE_STATUSES.NOT_INITIALIZED,
        createdBy: userId,
        updatedBy: userId,
      });
    }

    device.tin = tin;
    device.branchName = branch.branchName;
    device.branchRef = branch.branchRef;
    device.lastAttemptAt = new Date();
    device.lastAttemptMode = ebmService.getConfig().mode;
    device.updatedBy = userId;

    try {
      const response = await ebmService.initializeDevice({
        companyId,
        tin,
        bhfId: branchId,
        dvcSrlNo: device.deviceSerialNo,
      });

      device.status = EBM_DEVICE_STATUSES.INITIALIZED;
      device.initializedAt = new Date();
      device.initializedMode = ebmService.getConfig().mode;
      device.lastErrorMessage = null;
      device.initResult = response.raw;
      await device.save();
      await EBMFiscalSequenceService.seedFromInitInfo(
        companyId,
        branchId,
        extractInitInfo(response.data || response.raw?.data || {}),
      );

      return {
        success: true,
        device: toPublicDevice(device),
        response,
      };
    } catch (error) {
      device.status = EBM_DEVICE_STATUSES.FAILED;
      device.lastErrorMessage = error.message || 'EBM initialization failed';
      device.initResult = error.response || null;
      await device.save();
      throw error;
    }
  }
}

module.exports = EBMDeviceService;
module.exports.EBM_DEVICE_STATUSES = EBM_DEVICE_STATUSES;
module.exports.EBM_MODES = EBM_MODES;
