const Company = require('../models/Company');
const Warehouse = require('../models/Warehouse');
const Product = require('../models/Product');
const EBMDevice = require('../models/EBMDevice');
const EBMCode = require('../models/EBMCode');
const EBMSyncState = require('../models/EBMSyncState');
const ebmService = require('./ebmService');
const { EBM_DEVICE_STATUSES } = require('../models/EBMDevice');
const { READINESS_ACTIONS, formatSyncStates } = require('../constants/ebmUiMetadata');

function normalizeBranchId(value) {
  return String(value || '00').padStart(2, '0').slice(-2);
}

class EBMReadinessService {
  static async getReadiness(companyId, branchId = '00') {
    const normalizedBranchId = normalizeBranchId(branchId);
    const mode = ebmService.getConfig().mode;
    const [company, warehouse, device, codeCount, syncStates, unregisteredProducts] = await Promise.all([
      Company.findById(companyId).select('tax_identification_number registration_number tin name').lean(),
      Warehouse.findOne({ company: companyId, rraBranchId: normalizedBranchId }).lean(),
      EBMDevice.findOne({
        company: companyId,
        branchId: normalizedBranchId,
        status: EBM_DEVICE_STATUSES.INITIALIZED,
        initializedMode: mode,
      }).lean(),
      EBMCode.countDocuments({ company: companyId, active: { $ne: false } }),
      EBMSyncState.find({ company: companyId, mode }).lean(),
      Product.countDocuments({
        company: companyId,
        isActive: { $ne: false },
        $or: [
          { 'ebm.registrationStatus': { $ne: 'registered' } },
          { 'ebm.ebmItemCode': { $in: [null, ''] } },
        ],
      }),
    ]);

    const tin = String(
      company?.tax_identification_number ||
      company?.registration_number ||
      company?.tin ||
      '',
    ).trim();

    const checks = [
      {
        id: 'company_tin',
        label: 'Company TIN configured',
        ok: /^\d{9}$/.test(tin),
        detail: tin || 'Add your 9-digit Rwanda TIN in company settings',
        ...READINESS_ACTIONS.company_tin,
      },
      {
        id: 'device_initialized',
        label: `EBM device initialized (${mode})`,
        ok: !!device,
        detail: device
          ? `Ready since ${device.initializedAt ? new Date(device.initializedAt).toLocaleString() : 'initialization'}`
          : 'Connect and initialize your branch device before sending invoices to RRA',
        ...READINESS_ACTIONS.device_initialized,
      },
      {
        id: 'branch_registered',
        label: 'Branch registered with RRA',
        ok: warehouse?.ebmRegistrationStatus === 'registered',
        detail: warehouse?.ebmRegistrationStatus === 'registered'
          ? `Branch ${normalizedBranchId} is registered`
          : 'Register this warehouse branch with RRA before fiscal submissions',
        ...READINESS_ACTIONS.branch_registered,
      },
      {
        id: 'codes_synced',
        label: 'RRA reference codes synced',
        ok: codeCount > 0,
        detail: codeCount > 0
          ? `${codeCount} active code(s) available locally`
          : 'Sync payment methods, receipt types, and tax codes from RRA',
        ...READINESS_ACTIONS.codes_synced,
      },
      {
        id: 'products_registered',
        label: 'Products registered with RRA',
        ok: unregisteredProducts === 0,
        detail: unregisteredProducts === 0
          ? 'All active products have RRA item codes'
          : `${unregisteredProducts} active product(s) still need RRA registration`,
        ...READINESS_ACTIONS.products_registered,
      },
    ];

    const ready = checks.every((check) => check.ok);
    const syncSummary = formatSyncStates(syncStates, normalizedBranchId);
    return {
      companyId,
      branchId: normalizedBranchId,
      mode,
      ready,
      checks,
      syncStates,
      syncSummary,
    };
  }
}

module.exports = EBMReadinessService;
