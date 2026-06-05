const Warehouse = require('../models/Warehouse');
const User = require('../models/User');
const Product = require('../models/Product');
const ebmService = require('./ebmService');

const REGISTERED = 'registered';
const FAILED = 'failed';
const NOT_REGISTERED = 'not_registered';

function branchPayload(companyId, branch, company) {
  const location = branch.location || {};
  return {
    companyId,
    tin: company.tax_identification_number || company.registration_number,
    bhfId: branch.rraBranchId,
    bhfList: [{
      tin: company.tax_identification_number || company.registration_number,
      bhfId: branch.rraBranchId,
      bhfNm: branch.name,
      bhfSttsCd: branch.isActive === false ? '02' : '01',
      prvncNm: location.province || location.state || location.city || 'Kigali City',
      dstrtNm: location.district || location.city || 'Gasabo',
      sctrNm: location.sector || location.city || 'Remera',
      locDesc: location.address || branch.description || branch.name,
      mgrNm: location.contactPerson || company.name,
      mgrTelNo: location.phone || company.phone || '',
      mgrEmail: location.email || company.email || '',
      hqYn: branch.rraBranchId === '00' ? 'Y' : 'N',
      useYn: branch.isActive === false ? 'N' : 'Y',
    }],
  };
}

class EBMBranchService {
  static async isBranchRegistered(companyId, branchId) {
    const branch = await Warehouse.findOne({
      company: companyId,
      rraBranchId: branchId,
      ebmRegistrationStatus: REGISTERED,
    }).lean();
    return !!branch;
  }

  static async ensureBranchRegistered({ companyId, branchId, mode }) {
    const normalizedBranchId = String(branchId || '').padStart(2, '0').slice(-2);
    const ok = await this.isBranchRegistered(companyId, normalizedBranchId);
    if (!ok) {
      this.registerBranchById(companyId, normalizedBranchId).catch((err) => {
        console.error('[EBMBranch] Background registration failed:', err.message);
      });
      const { EBMServiceError } = require('./ebmService');
      throw new EBMServiceError(
        `EBM branch ${normalizedBranchId} is not registered with RRA for this tenant. Register the branch before submitting EBM transactions.`,
        { code: 'EBM_BRANCH_NOT_REGISTERED', mode, retryable: false },
      );
    }
  }

  static async registerBranchById(companyId, branchId, userId = null) {
    const branch = await Warehouse.findOne({ company: companyId, rraBranchId: branchId });
    if (!branch) {
      const error = new Error(`Branch ${branchId} not found`);
      error.statusCode = 404;
      throw error;
    }
    return this.registerBranch(companyId, branch, userId);
  }

  static async registerBranch(companyId, branch, userId = null) {
    const Company = require('../models/Company');
    const company = await Company.findById(companyId).lean();
    if (!company) throw new Error('Company not found');

    branch.ebmLastAttemptAt = new Date();
    try {
      await ebmService.saveBranchCustomers(branchPayload(companyId, branch, company));
      branch.ebmRegistrationStatus = REGISTERED;
      branch.ebmRegisteredAt = new Date();
      branch.ebmRegistrationError = null;
      await branch.save();

      await this.submitBranchUsers(companyId, branch.rraBranchId);
      await this.submitBranchInsurance(companyId, branch.rraBranchId);

      return branch;
    } catch (error) {
      branch.ebmRegistrationStatus = FAILED;
      branch.ebmRegistrationError = error.message || 'Branch registration failed';
      await branch.save();
      throw error;
    }
  }

  static async submitBranchUsers(companyId, branchId) {
    const users = await User.find({ company: companyId, isActive: true }).select('name email role phone').lean();
    const branch = await Warehouse.findOne({ company: companyId, rraBranchId: branchId });
    if (!branch) throw new Error(`Branch ${branchId} not found`);
    const Company = require('../models/Company');
    const company = await Company.findById(companyId).lean();
    await ebmService.saveBranchUsers({
      companyId,
      tin: company?.tax_identification_number || company?.registration_number,
      bhfId: branchId,
      userList: users.map((user) => ({
        userId: String(user._id),
        userNm: user.name,
        pwd: '',
        adrs: user.email,
        cntc: user.phone || '',
        authCd: user.role || 'user',
        useYn: 'Y',
      })),
    });
    branch.ebmUsersSubmitted = true;
    await branch.save();
    return { submitted: users.length };
  }

  static async submitBranchInsurance(companyId, branchId) {
    const branch = await Warehouse.findOne({ company: companyId, rraBranchId: branchId });
    if (!branch) throw new Error(`Branch ${branchId} not found`);
    const Company = require('../models/Company');
    const company = await Company.findById(companyId).lean();
    const insuranceList = Array.isArray(branch.ebmInsurances) ? branch.ebmInsurances : [];
    const activeInsurances = insuranceList
      .filter((item) => item && item.isrccCd && item.isrccNm && (item.useYn || 'Y') !== 'N')
      .map((item) => ({
        isrccCd: String(item.isrccCd).trim(),
        isrccNm: String(item.isrccNm).trim(),
        isrcRt: item.isrcRt == null ? 0 : Number(item.isrcRt),
        useYn: 'Y',
      }));

    const insuranceApplicableProductExists = await Product.exists({
      company: companyId,
      'ebm.isrcAplcbYn': 'Y',
      isActive: { $ne: false },
    });

    if (insuranceApplicableProductExists && activeInsurances.length === 0) {
      const error = new Error('EBM branch insurance list is required for insurance-applicable products');
      error.code = 'EBM_BRANCH_INSURANCE_REQUIRED';
      error.statusCode = 400;
      throw error;
    }

    if (activeInsurances.length === 0) {
      branch.ebmInsuranceSubmitted = false;
      await branch.save();
      return { submitted: 0 };
    }

    await ebmService.saveBranchInsurances({
      companyId,
      tin: company?.tax_identification_number || company?.registration_number,
      bhfId: branchId,
      isrccList: activeInsurances,
    });
    branch.ebmInsuranceSubmitted = true;
    await branch.save();
    return { submitted: activeInsurances.length };
  }
}

module.exports = EBMBranchService;
module.exports.BRANCH_EBM_STATUSES = { REGISTERED, FAILED, NOT_REGISTERED };
