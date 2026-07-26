const Company = require('../models/Company');
const Client = require('../models/Client');
const EBMDevice = require('../models/EBMDevice');
const EBMCode = require('../models/EBMCode');
const EBMItemClass = require('../models/EBMItemClass');
const EBMTIN = require('../models/EBMTIN');
const EBMNotice = require('../models/EBMNotice');
const EBMSyncState = require('../models/EBMSyncState');
const ebmService = require('./ebmService');
const { EBM_DEVICE_STATUSES } = require('../models/EBMDevice');
const { formatVsdcDateTime } = require('./ebmService');
const { EBM_SYNC_TYPES, EBM_CODE_SYNC_TYPES } = require('../constants/ebmSyncTypes');

const SYNC_TYPES = EBM_SYNC_TYPES;

const FIRST_SYNC_DT = '20000101000000';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function activeFrom(value) {
  if (value === undefined || value === null) return true;
  return String(value).toUpperCase() !== 'N' && String(value).toUpperCase() !== 'D';
}

async function getSyncState(companyId, branchId, syncType) {
  const mode = ebmService.getConfig().mode;
  return EBMSyncState.findOneAndUpdate(
    { company: companyId, branchId, syncType, mode },
    {
      $setOnInsert: {
        company: companyId,
        branchId,
        syncType,
        mode,
        lastReqDt: FIRST_SYNC_DT,
      },
      $set: { lastAttemptAt: new Date() },
    },
    { upsert: true, new: true },
  );
}

async function markSuccess(state, summary, responseDate) {
  state.lastReqDt = responseDate || formatVsdcDateTime();
  state.lastSuccessfulSyncAt = new Date();
  state.lastErrorMessage = null;
  state.summary = summary;
  await state.save();
}

async function markFailure(state, error) {
  state.lastErrorMessage = error.message || 'EBM code sync failed';
  await state.save();
}

class EBMCodeSyncService {
  static SYNC_TYPES = SYNC_TYPES;

  static async getInitializedDevice(companyId, branchId = '00') {
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

  static async getDefaultDevice(companyId) {
    const mode = ebmService.getConfig().mode;
    return EBMDevice.findOne({
      company: companyId,
      status: EBM_DEVICE_STATUSES.INITIALIZED,
      initializedMode: mode,
    }).sort({ branchId: 1 }).lean();
  }

  static async syncAll(companyId, options = {}) {
    const branchId = String(options.branchId || '00').padStart(2, '0').slice(-2);
    const full = options.full === true;
    const device = await this.getInitializedDevice(companyId, branchId);
    const basePayload = {
      companyId,
      tin: device.tin,
      bhfId: device.branchId,
    };

    const results = [];
    for (const syncType of EBM_CODE_SYNC_TYPES) {
      try {
        const result = await this.syncType(companyId, branchId, syncType, basePayload, { full });
        results.push(result);
      } catch (error) {
        results.push({
          syncType,
          success: false,
          error: error.message,
        });
      }
    }

    return {
      companyId,
      branchId,
      mode: ebmService.getConfig().mode,
      results,
    };
  }

  static async syncType(companyId, branchId, syncType, basePayload, options = {}) {
    const state = await getSyncState(companyId, branchId, syncType);
    const lastReqDt = options.full ? FIRST_SYNC_DT : (state.lastReqDt || FIRST_SYNC_DT);

    try {
      let result;
      switch (syncType) {
        case SYNC_TYPES.STANDARD_CODES:
          result = await this.syncStandardCodes(companyId, { ...basePayload, lastReqDt });
          break;
        case SYNC_TYPES.ITEM_CLASSES:
          result = await this.syncItemClasses(companyId, { ...basePayload, lastReqDt });
          break;
        case SYNC_TYPES.TINS:
          result = await this.syncTINs(companyId, { ...basePayload, lastReqDt });
          break;
        case SYNC_TYPES.BRANCHES:
          result = await this.syncBranches(companyId, { ...basePayload, lastReqDt });
          break;
        case SYNC_TYPES.NOTICES:
          result = await this.syncNotices(companyId, { ...basePayload, lastReqDt });
          break;
        default:
          throw new Error(`Unsupported EBM code sync type: ${syncType}`);
      }

      const summary = { syncType, upserted: result.upserted, matched: result.matched, lastReqDt };
      await markSuccess(state, summary, result.resultDt);
      return { success: true, ...summary, resultDt: result.resultDt };
    } catch (error) {
      await markFailure(state, error);
      throw error;
    }
  }

  static async syncStandardCodes(companyId, payload) {
    const response = await ebmService.selectCodes(payload);
    const classes = asArray(response.data?.clsList || response.data?.codeList);
    const ops = [];

    for (const codeClass of classes) {
      const codeClassValue = String(codeClass.cdCls || codeClass.cdClsCd || codeClass.codeClass || '').trim();
      if (!codeClassValue) continue;
      const items = asArray(codeClass.dtlList || codeClass.codeDtlList || codeClass.codes);
      for (const item of items) {
        const code = String(item.cd || item.dtlCd || item.code || '').trim();
        if (!code) continue;
        ops.push({
          updateOne: {
            filter: { company: companyId, codeClass: codeClassValue, code },
            update: {
              $set: {
                company: companyId,
                codeClass: codeClassValue,
                codeClassName: codeClass.cdClsNm || codeClass.codeClassName || null,
                code,
                name: item.cdNm || item.name || item.dtlCdNm || null,
                description: item.cdDesc || item.description || null,
                sortOrder: Number(item.srtOrd || item.sortOrder || 0),
                active: activeFrom(item.useYn || item.active),
                source: item,
                lastSyncedAt: new Date(),
              },
            },
            upsert: true,
          },
        });
      }
    }

    const write = ops.length ? await EBMCode.bulkWrite(ops) : {};
    return {
      upserted: write.upsertedCount || 0,
      matched: write.matchedCount || 0,
      resultDt: response.resultDt,
    };
  }

  static async syncItemClasses(companyId, payload) {
    const response = await ebmService.selectItemClasses(payload);
    const itemClasses = asArray(response.data?.itemClsList || response.data?.itemClassList);
    const ops = itemClasses.map((item) => {
      const itemClassCode = String(item.itemClsCd || item.itemClassCode || '').trim();
      const parentCode = itemClassCode.length > 2 ? itemClassCode.slice(0, -2) : null;
      return {
        updateOne: {
          filter: { company: companyId, itemClassCode },
          update: {
            $set: {
              company: companyId,
              itemClassCode,
              itemClassName: item.itemClsNm || item.itemClassName || itemClassCode,
              itemClassLevel: Number(item.itemClsLvl || item.level || 0) || null,
              parentCode,
              taxTypeCode: item.taxTyCd || null,
              majorTarget: String(item.mjrTgYn || '').toUpperCase() === 'Y',
              active: activeFrom(item.useYn || item.active),
              source: item,
              lastSyncedAt: new Date(),
            },
          },
          upsert: true,
        },
      };
    }).filter((op) => op.updateOne.filter.itemClassCode);

    const write = ops.length ? await EBMItemClass.bulkWrite(ops) : {};
    return { upserted: write.upsertedCount || 0, matched: write.matchedCount || 0, resultDt: response.resultDt };
  }

  static async syncTINs(companyId) {
    const clients = await Client.find({
      company: companyId,
      taxId: { $regex: /^\d{9}$/ },
      isActive: { $ne: false },
    }).select('taxId name ebmTinVerification').lean();

    const ops = clients.map((client) => {
      const tin = String(client.taxId || '').trim();
      const verification = client.ebmTinVerification || {};
      return {
        updateOne: {
          filter: { tin },
          update: {
            $set: {
              tin,
              taxpayerName: verification.taxpayerName || client.name || tin,
              statusCode: verification.statusCode || (verification.status === 'valid' ? 'A' : null),
              provinceName: verification.provinceName || null,
              districtName: verification.districtName || null,
              active: verification.status !== 'invalid',
              source: verification.source || { source: 'local_client_cache' },
              lastSyncedAt: new Date(),
            },
          },
          upsert: true,
        },
      };
    }).filter((op) => op.updateOne.filter.tin);

    const write = ops.length ? await EBMTIN.bulkWrite(ops) : {};
    return {
      upserted: write.upsertedCount || 0,
      matched: write.matchedCount || 0,
      resultDt: formatVsdcDateTime(),
      skippedApi: true,
      message: 'TIN directory synced from locally verified client records. Use customer TIN verify for live RRA lookup.',
    };
  }

  static async syncBranches(companyId, payload) {
    const response = await ebmService.selectBranches(payload);
    const branches = asArray(response.data?.bhfList || response.data?.branchList);
    const ops = branches.map((item) => {
      const branchId = String(item.bhfId || item.branchId || '').trim();
      return {
        updateOne: {
          filter: { company: companyId, codeClass: 'RRA_BRANCH', code: branchId },
          update: {
            $set: {
              company: companyId,
              codeClass: 'RRA_BRANCH',
              codeClassName: 'RRA Branch',
              code: branchId,
              name: item.bhfNm || item.branchName || branchId,
              active: activeFrom(item.useYn || item.active),
              source: item,
              lastSyncedAt: new Date(),
            },
          },
          upsert: true,
        },
      };
    }).filter((op) => op.updateOne.filter.code);

    const write = ops.length ? await EBMCode.bulkWrite(ops) : {};
    return { upserted: write.upsertedCount || 0, matched: write.matchedCount || 0, resultDt: response.resultDt };
  }

  static async syncNotices(companyId, payload) {
    const response = await ebmService.selectNotices(payload);
    const notices = asArray(response.data?.noticeList || response.data?.notices);
    const ops = notices.map((item) => {
      const noticeNumber = String(item.noticeNo || item.noticeNumber || item.ntcNo || '').trim();
      return {
        updateOne: {
          filter: { company: companyId, noticeNumber },
          update: {
            $set: {
              company: companyId,
              noticeNumber,
              title: item.title || item.noticeTitle || item.titl || null,
              content: item.cont || item.content || item.noticeContent || null,
              noticeDate: item.regrDt || item.noticeDate || item.dt || null,
              active: activeFrom(item.useYn || item.active),
              source: item,
              lastSyncedAt: new Date(),
            },
          },
          upsert: true,
        },
      };
    }).filter((op) => op.updateOne.filter.noticeNumber);

    const write = ops.length ? await EBMNotice.bulkWrite(ops) : {};
    return { upserted: write.upsertedCount || 0, matched: write.matchedCount || 0, resultDt: response.resultDt };
  }

  static async getSyncStates(companyId) {
    return EBMSyncState.find({ company: companyId }).sort({ syncType: 1 }).lean();
  }

  static async syncDueCompanies() {
    const intervalHours = Number(process.env.EBM_CODE_SYNC_INTERVAL_HOURS || 24);
    const staleBefore = new Date(Date.now() - intervalHours * 60 * 60 * 1000);
    const companies = await Company.find({ isActive: true }).select('_id name').lean();
    const summaries = [];

    for (const company of companies) {
      try {
        const device = await this.getDefaultDevice(company._id);
        if (!device) {
          summaries.push({ company: company._id, skipped: true, reason: 'No initialized EBM device' });
          continue;
        }
        const existing = await EBMSyncState.findOne({
          company: company._id,
          mode: ebmService.getConfig().mode,
          lastSuccessfulSyncAt: { $gte: staleBefore },
        }).lean();
        if (existing) {
          summaries.push({ company: company._id, skipped: true, reason: 'Recently synced' });
          continue;
        }
        summaries.push(await this.syncAll(company._id, { branchId: device.branchId }));
      } catch (error) {
        console.error(`[EBMCodeSync] Company ${company._id} failed:`, error.message);
        summaries.push({ company: company._id, success: false, error: error.message });
      }
    }

    return summaries;
  }
}

module.exports = EBMCodeSyncService;
