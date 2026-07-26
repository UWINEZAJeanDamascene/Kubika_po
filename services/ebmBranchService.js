const Warehouse = require('../models/Warehouse');
const User = require('../models/User');
const Product = require('../models/Product');
const Client = require('../models/Client');
const Company = require('../models/Company');
const ebmService = require('./ebmService');

const REGISTERED = 'registered';
const FAILED = 'failed';
const NOT_REGISTERED = 'not_registered';

function clean(value, max = 60, fallback = '') {
  const text = String(value || fallback || '').trim();
  return text.slice(0, max);
}

function normalizeTin(value) {
  const tin = String(value || '').replace(/\D/g, '').slice(0, 9);
  return tin.length === 9 ? tin : '';
}

function normalizeBranchId(value) {
  return String(value || '00').padStart(2, '0').slice(-2);
}

function actor(user, fallbackName = 'System') {
  const idSource = user?._id || user?.id || user?.email || user?.name || 'system';
  return {
    id: clean(idSource, 20, 'system'),
    name: clean(user?.name || fallbackName, 60, fallbackName),
  };
}

function getCompanyTin(company) {
  const tin = normalizeTin(company?.tax_identification_number || company?.registration_number || company?.tin);
  if (!tin) {
    const error = new Error('Company TIN must be a 9 digit value before submitting EBM branch data');
    error.code = 'EBM_COMPANY_TIN_REQUIRED';
    error.statusCode = 400;
    throw error;
  }
  return tin;
}

function buildBranchUserPayload(company, branchId, user, registrar = null) {
  const tin = getCompanyTin(company);
  const regr = actor(registrar || user, 'System');
  const userIdentifier = clean(user.email || user._id || user.id, 20, 'user');
  return {
    companyId: company._id,
    tin,
    bhfId: normalizeBranchId(branchId),
    userId: userIdentifier,
    userNm: clean(user.name, 60, userIdentifier),
    pwd: '0000000000',
    adrs: clean(user.email, 200),
    cntc: clean(user.phone, 20),
    regrId: regr.id,
    regrNm: regr.name,
    modrId: regr.id,
    modrNm: regr.name,
  };
}

function buildBranchCustomerPayload(company, branchId, client, registrar = null) {
  const tin = getCompanyTin(company);
  const regr = actor(registrar, 'System');
  const contact = client.contact || {};
  const custTin = normalizeTin(client.taxId || client.tin || client.tax_identification_number);
  return {
    companyId: company._id,
    tin,
    bhfId: normalizeBranchId(branchId),
    custNo: clean(client.code || client._id, 20, String(client._id).slice(-20)),
    custTin,
    custNm: clean(client.name, 60, 'Customer'),
    adrs: clean(contact.address || [contact.city, contact.state, contact.country].filter(Boolean).join(', '), 200),
    telNo: clean(contact.phone, 20),
    email: clean(contact.email, 100),
    faxNo: clean(contact.fax, 20),
    useYn: client.isActive === false ? 'N' : 'Y',
    regrId: regr.id,
    regrNm: regr.name,
    modrId: regr.id,
    modrNm: regr.name,
  };
}

function markClientBranchStatus(client, branchId, status, error = null) {
  const normalized = normalizeBranchId(branchId);
  const current = Array.isArray(client.ebmBranchCustomers) ? client.ebmBranchCustomers : [];
  const next = current.filter((item) => item.branchId !== normalized);
  next.push({
    branchId: normalized,
    status,
    submittedAt: status === REGISTERED ? new Date() : undefined,
    error: error ? clean(error, 500) : undefined,
  });
  client.ebmBranchCustomers = next;
}

class EBMBranchService {
  static async isBranchRegistered(companyId, branchId) {
    const branch = await Warehouse.findOne({
      company: companyId,
      rraBranchId: normalizeBranchId(branchId),
      ebmRegistrationStatus: REGISTERED,
    }).lean();
    return !!branch;
  }

  static async ensureBranchRegistered({ companyId, branchId, mode }) {
    const normalizedBranchId = normalizeBranchId(branchId);
    const { EBMServiceError } = require('./ebmService');

    const branch = await Warehouse.findOne({
      company: companyId,
      rraBranchId: normalizedBranchId,
    }).lean();

    if (!branch) {
      throw new EBMServiceError(
        `No warehouse is mapped to RRA branch ${normalizedBranchId}. Open Warehouses, set the RRA Branch ID on the warehouse (use 00 for the head office), then register the branch.`,
        { code: 'EBM_BRANCH_NOT_MAPPED', mode, retryable: false },
      );
    }

    if (branch.ebmRegistrationStatus === REGISTERED) return;

    // Register inline rather than in the background so the caller sees why it failed
    // instead of a generic "not registered" that never resolves.
    try {
      await this.registerBranchById(companyId, normalizedBranchId);
    } catch (error) {
      throw new EBMServiceError(
        `EBM branch ${normalizedBranchId} could not be registered with RRA: ${error.message}`,
        { code: 'EBM_BRANCH_NOT_REGISTERED', mode, retryable: false },
      );
    }
  }

  static async registerBranchById(companyId, branchId, userId = null) {
    const branch = await Warehouse.findOne({ company: companyId, rraBranchId: normalizeBranchId(branchId) });
    if (!branch) {
      const error = new Error(`Branch ${branchId} not found`);
      error.statusCode = 404;
      throw error;
    }
    return this.registerBranch(companyId, branch, userId);
  }

  static async verifyBranchExists(companyId, branch, company) {
    const tin = getCompanyTin(company);
    const branchId = normalizeBranchId(branch.rraBranchId);
    const response = await ebmService.selectBranches({
      companyId,
      tin,
      bhfId: branchId,
      lastReqDt: '20191130000000',
    });
    const list = response?.data?.bhfList || response?.raw?.data?.bhfList || [];
    const match = list.find((item) => normalizeBranchId(item.bhfId) === branchId);
    if (!match) {
      const error = new Error(`RRA VSDC branch ${branchId} was not returned by /branches/selectBranches`);
      error.code = 'EBM_BRANCH_NOT_FOUND_AT_RRA';
      error.statusCode = 400;
      throw error;
    }
    return match;
  }

  static async registerBranch(companyId, branch, userId = null) {
    const company = await Company.findById(companyId).lean();
    if (!company) throw new Error('Company not found');

    branch.ebmLastAttemptAt = new Date();
    try {
      await this.verifyBranchExists(companyId, branch, company);
      branch.ebmRegistrationStatus = REGISTERED;
      branch.ebmRegisteredAt = new Date();
      branch.ebmRegistrationError = null;
      await branch.save();

      await this.submitBranchUsers(companyId, branch.rraBranchId, userId);
      await this.submitBranchInsurance(companyId, branch.rraBranchId);

      return branch;
    } catch (error) {
      branch.ebmRegistrationStatus = FAILED;
      branch.ebmRegistrationError = error.message || 'Branch registration failed';
      await branch.save();
      throw error;
    }
  }

  static async submitBranchUsers(companyId, branchId, registrarUserId = null) {
    const normalizedBranchId = normalizeBranchId(branchId);
    const users = await User.find({ company: companyId, isActive: true }).select('name email role phone').lean();
    const branch = await Warehouse.findOne({ company: companyId, rraBranchId: normalizedBranchId });
    if (!branch) throw new Error(`Branch ${normalizedBranchId} not found`);
    const company = await Company.findById(companyId).lean();
    const registrar = registrarUserId ? await User.findOne({ _id: registrarUserId, company: companyId }).select('name email phone').lean() : null;

    for (const user of users) {
      await ebmService.saveBranchUser(buildBranchUserPayload(company, normalizedBranchId, user, registrar));
    }

    branch.ebmUsersSubmitted = true;
    await branch.save();
    return { submitted: users.length };
  }

  static async submitBranchInsurance(companyId, branchId) {
    const normalizedBranchId = normalizeBranchId(branchId);
    const branch = await Warehouse.findOne({ company: companyId, rraBranchId: normalizedBranchId });
    if (!branch) throw new Error(`Branch ${normalizedBranchId} not found`);
    const company = await Company.findById(companyId).lean();
    const insuranceList = Array.isArray(branch.ebmInsurances) ? branch.ebmInsurances : [];
    const activeInsurances = insuranceList
      .filter((item) => item && item.isrccCd && item.isrccNm && (item.useYn || 'Y') !== 'N')
      .map((item) => ({
        isrccCd: clean(item.isrccCd, 5),
        isrccNm: clean(item.isrccNm, 100),
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

    await ebmService.saveBranchInsurance({
      companyId,
      tin: getCompanyTin(company),
      bhfId: normalizedBranchId,
      isrccList: activeInsurances,
      regrId: 'system',
      regrNm: 'System',
      modrId: 'system',
      modrNm: 'System',
    });
    branch.ebmInsuranceSubmitted = true;
    await branch.save();
    return { submitted: activeInsurances.length };
  }

  static async saveBranchCustomer(companyId, clientId, branchId = '00', registrarUser = null) {
    const normalizedBranchId = normalizeBranchId(branchId);
    const [company, client] = await Promise.all([
      Company.findById(companyId).lean(),
      Client.findOne({ _id: clientId, company: companyId }),
    ]);
    if (!company) throw new Error('Company not found');
    if (!client) {
      const error = new Error('Client not found');
      error.statusCode = 404;
      throw error;
    }

    try {
      const payload = buildBranchCustomerPayload(company, normalizedBranchId, client, registrarUser);
      const response = await ebmService.saveBranchCustomer(payload);
      markClientBranchStatus(client, normalizedBranchId, REGISTERED);
      await client.save();
      return { client, payload, response };
    } catch (error) {
      markClientBranchStatus(client, normalizedBranchId, FAILED, error.message || 'Branch customer submission failed');
      await client.save();
      throw error;
    }
  }
}

module.exports = EBMBranchService;
module.exports.BRANCH_EBM_STATUSES = { REGISTERED, FAILED, NOT_REGISTERED };
module.exports.__test__ = {
  buildBranchUserPayload,
  buildBranchCustomerPayload,
  normalizeBranchId,
  normalizeTin,
};

