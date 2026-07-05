const Company = require('../models/Company');
const Warehouse = require('../models/Warehouse');
const Client = require('../models/Client');
const Invoice = require('../models/Invoice');
const EBMTIN = require('../models/EBMTIN');
const ebmService = require('./ebmService');

function normalizeTin(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 9);
}

function normalizeBranchId(value) {
  return String(value || '00').padStart(2, '0').slice(-2);
}

function getCompanyTin(company) {
  return normalizeTin(company?.tax_identification_number || company?.registration_number || company?.tin);
}

async function resolveBranchId(companyId, requestedBranchId = null) {
  if (requestedBranchId) return normalizeBranchId(requestedBranchId);
  const warehouse = await Warehouse.findOne({ company: companyId, isDefault: true }).lean()
    || await Warehouse.findOne({ company: companyId }).sort({ createdAt: 1 }).lean();
  return normalizeBranchId(warehouse?.rraBranchId || '00');
}

function selectCustomerRecord(response, customerTin) {
  const list = response?.data?.custList || response?.data?.customerList || response?.data?.tinList || [];
  return list.find((item) => normalizeTin(item.tin || item.custTin) === customerTin) || list[0] || null;
}

function buildVerification({ customerTin, branchId, response, record, status = 'valid', error = null }) {
  return {
    tin: customerTin,
    branchId,
    status,
    taxpayerName: record?.taxprNm || record?.custNm || record?.name || null,
    statusCode: record?.taxprSttsCd || record?.statusCode || null,
    provinceName: record?.prvncNm || null,
    districtName: record?.dstrtNm || null,
    verifiedAt: new Date(),
    resultCd: response?.resultCd || null,
    resultMsg: response?.resultMsg || error?.message || null,
    resultDt: response?.resultDt || null,
    source: record || response?.data || null,
  };
}

async function upsertTin(record, customerTin) {
  if (!record) return null;
  return EBMTIN.findOneAndUpdate(
    { tin: customerTin },
    {
      $set: {
        tin: customerTin,
        taxpayerName: record.taxprNm || record.custNm || record.name || customerTin,
        statusCode: record.taxprSttsCd || record.statusCode || null,
        provinceName: record.prvncNm || null,
        districtName: record.dstrtNm || null,
        active: String(record.useYn || record.active || 'Y').toUpperCase() !== 'N',
        source: record,
        lastSyncedAt: new Date(),
      },
    },
    { upsert: true, new: true },
  );
}

async function verifyTin(companyId, customerTinValue, options = {}) {
  const customerTin = normalizeTin(customerTinValue);
  if (!/^\d{9}$/.test(customerTin)) {
    const error = new Error('Customer TIN must be a 9 digit Rwanda TIN before RRA verification.');
    error.code = 'EBM_CUSTOMER_TIN_INVALID_FORMAT';
    error.retryable = false;
    throw error;
  }

  const company = await Company.findById(companyId).lean();
  const tin = getCompanyTin(company);
  if (!tin) {
    const error = new Error('Company TIN is required before verifying customer TIN with RRA.');
    error.code = 'EBM_COMPANY_TIN_REQUIRED';
    error.retryable = false;
    throw error;
  }

  const branchId = await resolveBranchId(companyId, options.branchId || options.bhfId);
  try {
    const response = await ebmService.selectCustomer({
      companyId,
      tin,
      bhfId: branchId,
      custmTin: customerTin,
      lastReqDt: options.lastReqDt || '20000101000000',
    });
    const record = selectCustomerRecord(response, customerTin);
    if (!record) {
      const error = new Error('RRA did not return a taxpayer record for this customer TIN.');
      error.code = 'EBM_CUSTOMER_TIN_NOT_FOUND';
      error.retryable = false;
      error.response = response;
      throw error;
    }
    await upsertTin(record, customerTin);
    return buildVerification({ customerTin, branchId, response, record, status: 'valid' });
  } catch (error) {
    if (error.code === 'EBM_CUSTOMER_TIN_INVALID_FORMAT' || error.code === 'EBM_COMPANY_TIN_REQUIRED') throw error;
    const response = error.response || error.cause?.response || null;
    const verification = buildVerification({ customerTin, branchId, response, record: null, status: 'invalid', error });
    error.verification = verification;
    error.retryable = false;
    if (!error.code) error.code = response?.resultCd === '884' ? 'EBM_CUSTOMER_TIN_INVALID' : 'EBM_CUSTOMER_TIN_VERIFY_FAILED';
    throw error;
  }
}

async function verifyClientTin(companyId, clientId, options = {}) {
  const client = await Client.findOne({ _id: clientId, company: companyId });
  if (!client) {
    const error = new Error('Client not found for RRA TIN verification.');
    error.code = 'EBM_CLIENT_NOT_FOUND';
    error.retryable = false;
    throw error;
  }
  const verification = await verifyTin(companyId, client.taxId, options).catch(async (error) => {
    if (error.verification) {
      client.ebmTinVerification = error.verification;
      await client.save();
    }
    throw error;
  });
  client.ebmTinVerification = verification;
  await client.save();
  return { client, verification };
}

async function verifyInvoiceCustomerTin(companyId, invoiceId, options = {}) {
  const invoice = await Invoice.findOne({ _id: invoiceId, company: companyId }).populate('client');
  if (!invoice) {
    const error = new Error('Invoice not found for RRA customer TIN verification.');
    error.code = 'EBM_INVOICE_NOT_FOUND';
    error.retryable = false;
    throw error;
  }
  const customerTin = invoice.customerTin || invoice.client?.taxId;
  const verification = await verifyTin(companyId, customerTin, options).catch(async (error) => {
    if (error.verification) {
      invoice.ebmCustomerTinVerification = error.verification;
      invoice.ebm = invoice.ebm || {};
      invoice.ebm.customerTinVerification = error.verification;
      await invoice.save();
    }
    throw error;
  });
  invoice.customerTin = verification.tin;
  invoice.ebmCustomerTinVerification = verification;
  invoice.ebm = invoice.ebm || {};
  invoice.ebm.customerTinVerification = verification;
  await invoice.save();
  if (invoice.client?._id) {
    await Client.updateOne(
      { _id: invoice.client._id, company: companyId, taxId: verification.tin },
      { $set: { ebmTinVerification: verification } },
    ).catch(() => {});
  }
  return { invoice, verification };
}

module.exports = {
  normalizeTin,
  verifyTin,
  verifyClientTin,
  verifyInvoiceCustomerTin,
};