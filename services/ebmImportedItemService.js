const EBMImportedItem = require('../models/EBMImportedItem');
const EBMDevice = require('../models/EBMDevice');
const EBMSyncState = require('../models/EBMSyncState');
const Company = require('../models/Company');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const PurchaseOrder = require('../models/PurchaseOrder');
const GoodsReceivedNote = require('../models/GoodsReceivedNote');
const ebmService = require('./ebmService');
const { EBM_DEVICE_STATUSES } = require('../models/EBMDevice');
const { formatVsdcDateTime } = require('./ebmService');
const { generateUniqueNumber } = require('../models/utils/autoIncrement');

const FIRST_SYNC_DT = '20000101000000';
const SYNC_TYPE = 'imported_items';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseVsdcDate(value) {
  if (!value) return null;
  const raw = String(value);
  if (/^\d{8}$/.test(raw)) {
    return new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00Z`);
  }
  if (/^\d{14}$/.test(raw)) {
    return new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}Z`);
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeBranchId(value) {
  return String(value || '00').padStart(2, '0').slice(-2);
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

function cleanString(value, maxLength, fallback = '') {
  const resolved = firstValue(value, fallback);
  return String(resolved == null ? '' : resolved).trim().slice(0, maxLength);
}

function toOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatVsdcDate(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (/^\d{8}$/.test(raw)) return raw;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function getActor(user) {
  const id = cleanString(user?.id || user?._id || user?.email || 'system', 20, 'system');
  const name = cleanString(user?.name || user?.fullName || user?.email || 'System', 60, 'System');
  return { id, name };
}

function omitBlankOptionalFields(payload, requiredFields) {
  const required = new Set(requiredFields);
  return Object.fromEntries(Object.entries(payload).filter(([key, value]) => {
    if (required.has(key)) return true;
    return value !== null && value !== undefined && value !== '';
  }));
}

function buildSaveImportItemPayload(imported, device, branchId, user, statusCode = '2') {
  const raw = imported.raw || {};
  const actor = getActor(user);
  const requiredFields = [
    'tin',
    'bhfId',
    'taskCd',
    'dclDe',
    'itemSeq',
    'dclNo',
    'hsCd',
    'imptItemSttsCd',
    'itemNm',
    'regrId',
    'regrNm',
    'modrId',
    'modrNm',
  ];

  const payload = {
    companyId: imported.company,
    tin: cleanString(device?.tin, 9),
    bhfId: normalizeBranchId(branchId),
    taskCd: cleanString(firstValue(raw.taskCd, imported.importTaskCode), 30),
    dclDe: formatVsdcDate(firstValue(raw.dclDe, raw.declarationDate, imported.importDate)),
    itemSeq: toOptionalNumber(firstValue(raw.itemSeq, raw.itemSequence, raw.seq, 1)),
    dclNo: cleanString(firstValue(raw.dclNo, imported.importDeclarationNo), 20),
    hsCd: cleanString(firstValue(raw.hsCd, raw.hscd, raw.hsCode), 10),
    imptItemSttsCd: cleanString(firstValue(statusCode, raw.imptItemSttsCd, '2'), 5),
    itemNm: cleanString(firstValue(raw.itemNm, imported.itemName), 200),
    orgnNatCd: cleanString(firstValue(raw.orgnNatCd, imported.originCountryCode), 5),
    exptNatCd: cleanString(raw.exptNatCd, 5),
    pkg: toOptionalNumber(raw.pkg),
    pkgUnitCd: cleanString(raw.pkgUnitCd, 5),
    qty: toOptionalNumber(firstValue(raw.qty, imported.quantity)),
    qtyUnitCd: cleanString(firstValue(raw.qtyUnitCd, imported.unitCode), 5),
    totWt: toOptionalNumber(raw.totWt),
    netWt: toOptionalNumber(raw.netWt),
    spplrNm: cleanString(firstValue(raw.spplrNm, raw.splrNm, imported.supplierName), 60),
    agntNm: cleanString(raw.agntNm, 60),
    invcFcurAmt: toOptionalNumber(raw.invcFcurAmt),
    invcFcurCd: cleanString(raw.invcFcurCd, 5),
    invcFcurExcrt: toOptionalNumber(raw.invcFcurExcrt),
    dclRefNum: cleanString(raw.dclRefNum, 30),
    regrId: actor.id,
    regrNm: actor.name,
    modrId: actor.id,
    modrNm: actor.name,
  };

  const missing = requiredFields.filter((field) => payload[field] === null || payload[field] === undefined || payload[field] === '');
  if (missing.length) {
    const error = new Error(`Imported item is missing RRA confirmation fields: ${missing.join(', ')}`);
    error.code = 'EBM_IMPORT_ITEM_PAYLOAD_INVALID';
    error.statusCode = 400;
    error.retryable = false;
    error.missingFields = missing;
    throw error;
  }

  return omitBlankOptionalFields(payload, requiredFields);
}
function normalizeImportedItem(raw, companyId, branchId) {
  const importTaskCode = String(raw.taskCd || raw.importTaskCode || raw.taskCode || raw.taskNo || raw.dclNo || '').trim();
  const quantity = Number(raw.qty || raw.quantity || raw.importQty || 0);
  const taxTypeCode = raw.taxTyCd || raw.taxTypeCode || null;

  return {
    company: companyId,
    branchId,
    importTaskCode,
    importDeclarationNo: raw.dclNo || raw.declarationNo || raw.importDeclarationNo || null,
    importDate: parseVsdcDate(raw.dclDe || raw.importDate || raw.dclDt),
    itemCode: raw.itemCd || raw.itemCode || null,
    itemName: raw.itemNm || raw.itemName || raw.goodsNm || importTaskCode,
    itemClassCode: raw.itemClsCd || raw.itemClassCode || null,
    quantity,
    unitCode: raw.qtyUnitCd || raw.unitCode || raw.qtyUnit || null,
    originCountryCode: raw.orgnNatCd || raw.originCountryCode || raw.countryCode || null,
    supplierTin: raw.splrTin || raw.supplierTin || null,
    supplierName: raw.splrNm || raw.supplierName || null,
    unitCost: Number(raw.prc || raw.unitCost || raw.amount || 0),
    taxTypeCode,
    taxRate: taxTypeCode === 'B' ? 18 : 0,
    raw,
    pulledAt: new Date(),
  };
}

async function getInitializedDevice(companyId, branchId) {
  const mode = ebmService.getConfig().mode;
  const device = await EBMDevice.findOne({
    company: companyId,
    branchId,
    status: EBM_DEVICE_STATUSES.INITIALIZED,
    initializedMode: mode,
  }).lean();

  if (!device) {
    const error = new Error(`EBM device is not initialized for branch ${branchId} in ${mode} mode.`);
    error.code = 'EBM_DEVICE_NOT_INITIALIZED';
    error.statusCode = 409;
    throw error;
  }
  return device;
}

async function getSyncState(companyId, branchId) {
  const mode = ebmService.getConfig().mode;
  return EBMSyncState.findOneAndUpdate(
    { company: companyId, branchId, syncType: SYNC_TYPE, mode },
    {
      $setOnInsert: { company: companyId, branchId, syncType: SYNC_TYPE, mode, lastReqDt: FIRST_SYNC_DT },
      $set: { lastAttemptAt: new Date() },
    },
    { upsert: true, new: true },
  );
}

async function runController(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        if (this.statusCode >= 400 || payload?.success === false) {
          const err = new Error(payload?.message || 'Controller request failed');
          err.statusCode = this.statusCode;
          err.payload = payload;
          reject(err);
          return;
        }
        resolve(payload);
      },
    };
    handler(req, res, reject);
  });
}

class EBMImportedItemService {
  static async syncImports(companyId, options = {}) {
    const branchId = normalizeBranchId(options.branchId || options.bhfId || '00');
    const full = options.full === true;
    const device = await getInitializedDevice(companyId, branchId);
    const state = await getSyncState(companyId, branchId);
    const lastReqDt = full ? FIRST_SYNC_DT : (state.lastReqDt || FIRST_SYNC_DT);

    try {
      const response = await ebmService.selectImportItems({
        companyId,
        tin: device.tin,
        bhfId: branchId,
        lastReqDt,
      });
      const items = asArray(response.data?.itemList || response.data?.importItemList || response.data?.imports);
      const ops = [];

      for (const item of items) {
        const normalized = normalizeImportedItem(item, companyId, branchId);
        if (!normalized.importTaskCode) continue;
        ops.push({
          updateOne: {
            filter: { company: companyId, branchId, importTaskCode: normalized.importTaskCode },
            update: {
              $set: normalized,
              $setOnInsert: { confirmationStatus: 'pending', stockUpdated: false },
            },
            upsert: true,
          },
        });
      }

      const write = ops.length ? await EBMImportedItem.bulkWrite(ops) : {};
      state.lastReqDt = response.resultDt || formatVsdcDateTime();
      state.lastSuccessfulSyncAt = new Date();
      state.lastErrorMessage = null;
      state.summary = {
        syncType: SYNC_TYPE,
        lastReqDt,
        received: items.length,
        upserted: write.upsertedCount || 0,
        matched: write.matchedCount || 0,
      };
      await state.save();

      return {
        branchId,
        mode: ebmService.getConfig().mode,
        ...state.summary,
        resultDt: response.resultDt,
      };
    } catch (error) {
      state.lastErrorMessage = error.message || 'Imported item sync failed';
      await state.save();
      throw error;
    }
  }

  static async syncDueCompanies() {
    const intervalHours = Math.max(1, Number(process.env.EBM_IMPORT_SYNC_INTERVAL_HOURS || 12));
    const dueBefore = new Date(Date.now() - intervalHours * 60 * 60 * 1000);
    const devices = await EBMDevice.find({
      status: EBM_DEVICE_STATUSES.INITIALIZED,
      initializedMode: ebmService.getConfig().mode,
    }).lean();

    const results = [];
    for (const device of devices) {
      const state = await EBMSyncState.findOne({
        company: device.company,
        branchId: device.branchId,
        syncType: SYNC_TYPE,
        mode: ebmService.getConfig().mode,
      }).lean();
      if (state?.lastSuccessfulSyncAt && state.lastSuccessfulSyncAt > dueBefore) continue;

      try {
        results.push({ company: device.company, branchId: device.branchId, success: true, data: await this.syncImports(device.company, { branchId: device.branchId }) });
      } catch (error) {
        results.push({ company: device.company, branchId: device.branchId, success: false, error: error.message });
      }
    }
    return { checked: devices.length, results };
  }

  static async listImports(companyId, query = {}) {
    const filter = { company: companyId };
    if (query.status) filter.confirmationStatus = query.status;
    if (query.branchId) filter.branchId = normalizeBranchId(query.branchId);
    return EBMImportedItem.find(filter)
      .populate('product', 'name sku')
      .populate('warehouse', 'name code')
      .populate('supplier', 'name code')
      .populate('grn', 'referenceNo status')
      .sort({ importDate: -1, createdAt: -1 })
      .limit(Math.min(Number(query.limit || 100), 500));
  }

  static async confirmImport(companyId, importId, options, user) {
    const branchId = normalizeBranchId(options.branchId || options.bhfId || '00');
    const imported = await EBMImportedItem.findOne({ _id: importId, company: companyId });
    if (!imported) {
      const error = new Error('Imported item not found');
      error.statusCode = 404;
      throw error;
    }
    if (imported.confirmationStatus === 'confirmed' && imported.stockUpdated) return imported;

    const device = await getInitializedDevice(companyId, branchId);
    try {
      const payload = buildSaveImportItemPayload(imported, device, branchId, user, '2');
      const response = await ebmService.saveImportItems(payload);
      imported.confirmationStatus = 'confirmed';
      imported.rraConfirmedAt = new Date();
      imported.rraResult = response.raw || response;
      imported.confirmationError = null;
      imported.confirmedAt = new Date();
      imported.confirmedBy = user?.id || user?._id || null;
      await imported.save();
    } catch (error) {
      imported.confirmationError = error.message || 'RRA import confirmation failed';
      await imported.save();
      throw error;
    }

    try {
      await this.updateStockFromImport(imported, options, user);
    } catch (error) {
      imported.stockUpdated = false;
      imported.stockUpdateError = error.message || 'Stock update failed after RRA import confirmation';
      await imported.save();
      return imported;
    }

    return EBMImportedItem.findById(imported._id).populate('grn', 'referenceNo status');
  }

  static async updateStockFromImport(imported, options, user) {
    if (imported.stockUpdated && imported.grn) return imported;

    const companyId = imported.company;
    const productId = options.productId || imported.product;
    const warehouseId = options.warehouseId || options.warehouse || imported.warehouse;
    if (!productId || !warehouseId) {
      throw new Error('Product and warehouse are required to update stock from an imported item.');
    }

    const product = await Product.findOne({ _id: productId, company: companyId });
    if (!product) throw new Error('Selected product was not found for this company.');

    const grnController = require('../controllers/grnController');
    const controllerUser = {
      company: { _id: companyId },
      id: user?.id || user?._id,
      _id: user?.id || user?._id,
      name: user?.name,
      email: user?.email,
    };

    if (imported.grn) {
      const existingGrn = await GoodsReceivedNote.findOne({ _id: imported.grn, company: companyId });
      if (!existingGrn) throw new Error('Linked GRN was not found for retry.');
      if (existingGrn.status !== 'confirmed') {
        await runController(grnController.confirmGRN, {
          user: controllerUser,
          params: { id: imported.grn },
          body: {},
        });
      }
      imported.stockUpdated = true;
      imported.stockUpdateError = null;
      await imported.save();
      return imported;
    }

    let supplier = null;
    if (options.supplierId) {
      supplier = await Supplier.findOne({ _id: options.supplierId, company: companyId });
    }
    if (!supplier && imported.supplierTin) {
      supplier = await Supplier.findOne({ company: companyId, taxId: imported.supplierTin });
    }
    if (!supplier) {
      supplier = await Supplier.create({
        company: companyId,
        name: imported.supplierName || 'RRA Imported Supplier',
        taxId: imported.supplierTin || undefined,
        contact: { country: imported.originCountryCode || undefined },
        createdBy: user?.id || user?._id || undefined,
      });
    }

    const po = await PurchaseOrder.create({
      company: companyId,
      supplier: supplier._id,
      warehouse: warehouseId,
      status: 'approved',
      currencyCode: 'RWF',
      orderDate: imported.importDate || new Date(),
      expectedDeliveryDate: new Date(),
      notes: `Auto-created from RRA import ${imported.importTaskCode}`,
      approvedBy: user?.id || user?._id || undefined,
      approvedAt: new Date(),
      createdBy: user?.id || user?._id || undefined,
      lines: [{
        product: product._id,
        qtyOrdered: imported.quantity,
        unitCost: imported.unitCost || Number(options.unitCost || 0),
        taxRate: imported.taxRate || Number(options.taxRate || 0),
      }],
    });

    const poLine = po.lines[0];
    const referenceNo = await generateUniqueNumber('GRN', GoodsReceivedNote, companyId, 'referenceNo');
    const baseReq = {
      user: controllerUser,
      body: {
        purchaseOrderId: po._id,
        warehouse: warehouseId,
        referenceNo,
        supplierInvoiceNo: imported.importDeclarationNo || imported.importTaskCode,
        receivedDate: new Date(),
        lines: [{
          purchaseOrderLine: poLine._id,
          product: product._id,
          qtyReceived: imported.quantity,
          unitCost: imported.unitCost || Number(options.unitCost || 0),
          taxRate: imported.taxRate || Number(options.taxRate || 0),
        }],
      },
    };

    const created = await runController(grnController.createGRN, baseReq);
    const grn = created.data;
    await GoodsReceivedNote.updateOne(
      { _id: grn._id, company: companyId },
      { $set: { ebmImportReference: imported.importTaskCode, ebmImportedItem: imported._id } },
    );
    imported.product = product._id;
    imported.warehouse = warehouseId;
    imported.supplier = supplier._id;
    imported.purchaseOrder = po._id;
    imported.grn = grn._id;
    await imported.save();

    await runController(grnController.confirmGRN, {
      ...baseReq,
      params: { id: grn._id },
      body: {},
    });

    imported.stockUpdated = true;
    imported.stockUpdateError = null;
    await imported.save();
    return imported;
  }

  static async retryStockUpdate(companyId, importId, options, user) {
    const imported = await EBMImportedItem.findOne({ _id: importId, company: companyId });
    if (!imported) {
      const error = new Error('Imported item not found');
      error.statusCode = 404;
      throw error;
    }
    if (imported.confirmationStatus !== 'confirmed') {
      const error = new Error('Only RRA-confirmed imports can retry stock update.');
      error.statusCode = 409;
      throw error;
    }
    await this.updateStockFromImport(imported, options, user);
    return EBMImportedItem.findById(imported._id).populate('grn', 'referenceNo status');
  }

  static async rejectImport(companyId, importId, reason, user) {
    const imported = await EBMImportedItem.findOne({ _id: importId, company: companyId });
    if (!imported) {
      const error = new Error('Imported item not found');
      error.statusCode = 404;
      throw error;
    }
    if (imported.confirmationStatus === 'confirmed') {
      const error = new Error('Confirmed imported items cannot be rejected.');
      error.statusCode = 409;
      throw error;
    }

    imported.confirmationStatus = 'rejected';
    imported.rejectionReason = reason || 'Rejected by user';
    imported.rejectedAt = new Date();
    imported.rejectedBy = user?.id || user?._id || null;
    await imported.save();
    return imported;
  }
}

EBMImportedItemService.__test__ = { buildSaveImportItemPayload };

module.exports = EBMImportedItemService;


