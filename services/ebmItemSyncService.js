const Product = require('../models/Product');
const EBMDevice = require('../models/EBMDevice');
const EBMSyncState = require('../models/EBMSyncState');
const ebmService = require('./ebmService');
const { EBM_DEVICE_STATUSES } = require('../models/EBMDevice');
const { formatVsdcDateTime } = require('./ebmService');
const { EBM_SYNC_TYPES } = require('../constants/ebmSyncTypes');

const FIRST_SYNC_DT = '20000101000000';
const SYNC_TYPE = EBM_SYNC_TYPES.REGISTERED_ITEMS;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeBranchId(value) {
  return String(value || '00').padStart(2, '0').slice(-2);
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

class EBMItemSyncService {
  static async syncRegisteredItems(companyId, options = {}) {
    const branchId = normalizeBranchId(options.branchId || options.bhfId || '00');
    const full = options.full === true;
    const device = await getInitializedDevice(companyId, branchId);
    const state = await getSyncState(companyId, branchId);
    const lastReqDt = full ? FIRST_SYNC_DT : (state.lastReqDt || FIRST_SYNC_DT);

    const response = await ebmService.selectItems({
      companyId,
      tin: device.tin,
      bhfId: branchId,
      lastReqDt,
    });

    const itemList = asArray(response.data?.itemList);
    const localProducts = await Product.find({
      company: companyId,
      'ebm.ebmItemCode': { $in: itemList.map((item) => item.itemCd).filter(Boolean) },
    }).select('name sku ebm').lean();
    const localByCode = new Map(localProducts.map((product) => [product.ebm?.ebmItemCode, product]));

    const rows = itemList.map((item) => {
      const local = localByCode.get(item.itemCd) || null;
      return {
        itemCd: item.itemCd,
        itemNm: item.itemNm,
        itemClsCd: item.itemClsCd,
        taxTyCd: item.taxTyCd,
        useYn: item.useYn,
        localProductId: local?._id || null,
        localProductName: local?.name || null,
        matchStatus: local ? 'matched' : 'missing_local',
      };
    });

    state.lastReqDt = response.resultDt || formatVsdcDateTime();
    state.lastSuccessfulSyncAt = new Date();
    state.lastErrorMessage = null;
    state.summary = {
      pulled: rows.length,
      matched: rows.filter((row) => row.matchStatus === 'matched').length,
      missingLocal: rows.filter((row) => row.matchStatus === 'missing_local').length,
    };
    await state.save();

    return {
      companyId,
      branchId,
      mode: ebmService.getConfig().mode,
      lastReqDt: state.lastReqDt,
      lastSyncedAt: state.lastSuccessfulSyncAt || null,
      items: rows,
      summary: state.summary,
    };
  }
}

module.exports = EBMItemSyncService;
