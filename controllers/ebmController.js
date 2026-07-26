const EBMDeviceService = require('../services/ebmDeviceService');
const EBMCodeSyncService = require('../services/ebmCodeSyncService');
const EBMCode = require('../models/EBMCode');
const EBMItemClass = require('../models/EBMItemClass');
const EBMTIN = require('../models/EBMTIN');
const EBMNotice = require('../models/EBMNotice');
const EBMBranchService = require('../services/ebmBranchService');
const EBMImportedItemService = require('../services/ebmImportedItemService');
const EBMPurchaseService = require('../services/ebmPurchaseService');
const EBMSubmissionQueue = require('../models/EBMSubmissionQueue');
const EBMAlert = require('../models/EBMAlert');
const EBMQueueService = require('../services/ebmQueueService');
const EBMStockService = require('../services/ebmStockService');
const EBMReadinessService = require('../services/ebmReadinessService');
const EBMSalesSyncService = require('../services/ebmSalesSyncService');
const EBMItemSyncService = require('../services/ebmItemSyncService');

function getCompanyId(req) {
  return req.companyId || req.company?._id || req.user?.company?._id || req.user?.company;
}

exports.getDeviceStatus = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const status = await EBMDeviceService.getInitializationStatus(companyId);
    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    next(error);
  }
};

exports.initializeDevice = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const result = await EBMDeviceService.initializeDevice(
      companyId,
      {
        branchId: req.body.branchId,
        bhfId: req.body.bhfId,
        deviceSerialNo: req.body.deviceSerialNo,
        dvcSrlNo: req.body.dvcSrlNo,
        tin: req.body.tin,
      },
      req.user?._id || req.user?.id || null,
    );

    res.json({
      success: true,
      data: result.device,
      vsdc: {
        resultCd: result.response.resultCd,
        resultMsg: result.response.resultMsg,
        resultDt: result.response.resultDt,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.syncCodes = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const result = await EBMCodeSyncService.syncAll(companyId, {
      branchId: req.body.branchId || req.body.bhfId || '00',
      full: req.body.full === true,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

exports.getCodeSyncStatus = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const states = await EBMCodeSyncService.getSyncStates(companyId);
    res.json({ success: true, data: states });
  } catch (error) {
    next(error);
  }
};

exports.getCodes = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const query = { company: companyId, active: { $ne: false } };
    if (req.query.codeClass) query.codeClass = String(req.query.codeClass);

    const codes = await EBMCode.find(query).sort({ codeClass: 1, sortOrder: 1, code: 1 }).lean();
    const grouped = codes.reduce((acc, code) => {
      if (!acc[code.codeClass]) {
        acc[code.codeClass] = {
          codeClass: code.codeClass,
          codeClassName: code.codeClassName,
          codes: [],
        };
      }
      acc[code.codeClass].codes.push({
        code: code.code,
        name: code.name,
        description: code.description,
        active: code.active,
        source: code.source,
      });
      return acc;
    }, {});

    res.json({ success: true, data: grouped });
  } catch (error) {
    next(error);
  }
};

exports.getItemClasses = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const search = String(req.query.search || '').trim();
    const query = { company: companyId, active: { $ne: false } };
    if (search) {
      query.$or = [
        { itemClassCode: { $regex: search, $options: 'i' } },
        { itemClassName: { $regex: search, $options: 'i' } },
      ];
    }

    const itemClasses = await EBMItemClass.find(query)
      .sort({ itemClassCode: 1 })
      .limit(Math.min(Number(req.query.limit || 1000), 5000))
      .lean();

    res.json({ success: true, data: itemClasses });
  } catch (error) {
    next(error);
  }
};

exports.searchTINs = async (req, res, next) => {
  try {
    const search = String(req.query.search || req.query.q || '').trim();
    const limit = Math.min(Number(req.query.limit || 20), 100);
    const query = { active: { $ne: false } };
    if (search) {
      query.$or = [
        { tin: { $regex: `^${search}`, $options: 'i' } },
        { taxpayerName: { $regex: search, $options: 'i' } },
      ];
    }
    const tins = await EBMTIN.find(query)
      .sort({ tin: 1 })
      .limit(limit)
      .lean();
    res.json({ success: true, data: tins });
  } catch (error) {
    next(error);
  }
};


exports.verifyCustomerTin = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const EBMTinService = require('../services/ebmCustomerTinService');
    const verification = await EBMTinService.verifyTin(companyId, req.body.tin || req.body.custmTin || req.body.custTin, {
      branchId: req.body.branchId || req.body.bhfId || '00',
    });
    res.json({ success: true, data: verification, verification });
  } catch (error) {
    next(error);
  }
};
exports.getNotices = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const notices = await EBMNotice.find({ company: companyId, active: { $ne: false } })
      .sort({ noticeDate: -1, createdAt: -1 })
      .limit(Math.min(Number(req.query.limit || 50), 200))
      .lean();
    res.json({ success: true, data: notices });
  } catch (error) {
    next(error);
  }
};

exports.registerBranch = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const branchId = String(req.body.branchId || req.body.bhfId || '').padStart(2, '0').slice(-2);
    const branch = await EBMBranchService.registerBranchById(companyId, branchId, req.user?._id || req.user?.id || null);
    res.json({ success: true, data: branch });
  } catch (error) {
    next(error);
  }
};

exports.syncImportedItems = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const result = await EBMImportedItemService.syncImports(companyId, {
      branchId: req.body.branchId || req.body.bhfId || '00',
      full: req.body.full === true,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

exports.listImportedItems = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const imports = await EBMImportedItemService.listImports(companyId, req.query);
    res.json({ success: true, data: imports });
  } catch (error) {
    next(error);
  }
};

exports.confirmImportedItem = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const imported = await EBMImportedItemService.confirmImport(
      companyId,
      req.params.id,
      req.body,
      req.user,
    );
    res.json({ success: true, data: imported });
  } catch (error) {
    next(error);
  }
};

exports.rejectImportedItem = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const imported = await EBMImportedItemService.rejectImport(
      companyId,
      req.params.id,
      req.body.reason,
      req.user,
    );
    res.json({ success: true, data: imported });
  } catch (error) {
    next(error);
  }
};

exports.retryImportedItemStock = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const imported = await EBMImportedItemService.retryStockUpdate(
      companyId,
      req.params.id,
      req.body,
      req.user,
    );
    res.json({ success: true, data: imported });
  } catch (error) {
    next(error);
  }
};
exports.reconcileStockMaster = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const result = await EBMStockService.reconcileStockMaster(companyId, {
      branchId: req.body.branchId || req.body.bhfId || '00',
      lastReqDt: req.body.lastReqDt,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

exports.resubmitStockMaster = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const result = await EBMStockService.resubmitStockMasterFromReconciliation(
      companyId,
      {
        branchId: req.body.branchId || req.body.bhfId || '00',
        itemCd: req.body.itemCd,
        itemCode: req.body.itemCode,
        productId: req.body.productId,
        allDiscrepancies: req.body.allDiscrepancies === true,
        lastReqDt: req.body.lastReqDt,
      },
      req.user,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

exports.syncPurchases = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const result = await EBMPurchaseService.syncPurchases(companyId, {
      branchId: req.body.branchId || req.body.bhfId || '00',
      full: req.body.full === true,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

exports.listUnmatchedPurchases = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const purchases = await EBMPurchaseService.listUnmatched(companyId, req.query);
    res.json({ success: true, data: purchases });
  } catch (error) {
    next(error);
  }
};

exports.listSubmissionQueue = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const filter = { companyId };
    if (req.query.status) filter.ebmStatus = req.query.status;
    if (!req.query.status) filter.ebmStatus = { $ne: 'submitted' };
    if (req.query.documentType) filter.documentType = req.query.documentType;
    if (req.query.companyId && ['platform_admin', 'superadmin'].includes(req.user?.role)) {
      filter.companyId = req.query.companyId;
    }
    if (req.query.fromDate || req.query.toDate) {
      filter.createdAt = {};
      if (req.query.fromDate) filter.createdAt.$gte = new Date(req.query.fromDate);
      if (req.query.toDate) filter.createdAt.$lte = new Date(req.query.toDate);
    }

    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(Math.max(1, Number(req.query.pageSize || req.query.limit || 20)), 100);
    const skip = (page - 1) * pageSize;
    const queue = await EBMSubmissionQueue.find(filter)
      .sort({ ebmStatus: 1, nextRetryAt: 1, createdAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .populate('companyId', 'name code')
      .lean();
    const total = await EBMSubmissionQueue.countDocuments(filter);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const counts = await EBMSubmissionQueue.aggregate([
      { $match: { companyId } },
      { $group: { _id: '$ebmStatus', count: { $sum: 1 } } },
    ]);
    const submittedToday = await EBMSubmissionQueue.countDocuments({
      companyId,
      ebmStatus: 'submitted',
      resolvedAt: { $gte: today },
    });
    const unacknowledgedAlerts = await EBMAlert.countDocuments({ companyId, acknowledged: false });
    res.json({
      success: true,
      data: {
        counts: {
          ...counts.reduce((acc, item) => ({ ...acc, [item._id]: item.count }), {}),
          submittedToday,
          unacknowledgedAlerts,
        },
        queue,
        records: queue,
        pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.getSubmissionQueueItem = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const item = await EBMSubmissionQueue.findOne({ _id: req.params.id, companyId })
      .populate('companyId', 'name code')
      .lean();
    if (!item) return res.status(404).json({ success: false, message: 'EBM queue item not found' });
    res.json({ success: true, data: item });
  } catch (error) {
    next(error);
  }
};

exports.retryQueueItem = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const item = await EBMQueueService.resetForManualRetry(req.params.id, companyId);
    if (!item) return res.status(404).json({ success: false, message: 'EBM queue item not found' });
    const { processRecord } = require('../services/ebmRetryJob');
    const result = await processRecord(item);
    const refreshed = await EBMSubmissionQueue.findOne({ _id: item._id, companyId }).lean();
    res.json({ success: true, data: refreshed, result });
  } catch (error) {
    next(error);
  }
};

exports.bulkRetryQueueItems = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    const results = [];
    for (const id of ids) {
      try {
        const item = await EBMQueueService.resetForManualRetry(id, companyId);
        if (!item) {
          results.push({ id, ok: false, message: 'Not found' });
        } else {
          results.push({ id, ok: true, status: item.ebmStatus });
        }
      } catch (error) {
        results.push({ id, ok: false, message: error.message });
      }
    }
    res.json({
      success: true,
      data: {
        reset: results.filter((item) => item.ok).length,
        failed: results.filter((item) => !item.ok),
        results,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.markQueueItemResolved = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const item = await EBMSubmissionQueue.findOneAndUpdate(
      { _id: req.params.id, companyId },
      { $set: { ebmStatus: 'submitted', resolvedAt: new Date(), isRetryable: false } },
      { new: true },
    );
    if (!item) return res.status(404).json({ success: false, message: 'EBM queue item not found' });
    res.json({ success: true, data: item });
  } catch (error) {
    next(error);
  }
};

exports.listAlerts = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const filter = { companyId, acknowledged: false };
    if (req.query.documentType) filter.documentType = req.query.documentType;
    if (req.query.fromDate || req.query.toDate) {
      filter.abandonedAt = {};
      if (req.query.fromDate) filter.abandonedAt.$gte = new Date(req.query.fromDate);
      if (req.query.toDate) filter.abandonedAt.$lte = new Date(req.query.toDate);
    }
    const alerts = await EBMAlert.find(filter).sort({ abandonedAt: -1 }).limit(200).lean();
    res.json({ success: true, data: alerts });
  } catch (error) {
    next(error);
  }
};

exports.acknowledgeAlert = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const alert = await EBMAlert.findOneAndUpdate(
      { _id: req.params.id, companyId },
      {
        $set: {
          acknowledged: true,
          acknowledgedAt: new Date(),
          acknowledgedBy: req.user?._id || req.user?.id || null,
          status: 'acknowledged',
        },
      },
      { new: true },
    );
    if (!alert) return res.status(404).json({ success: false, message: 'EBM alert not found' });
    res.json({ success: true, data: alert });
  } catch (error) {
    next(error);
  }
};

exports.resetAlert = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const alert = await EBMAlert.findOne({ _id: req.params.id, companyId });
    if (!alert) return res.status(404).json({ success: false, message: 'EBM alert not found' });
    const item = await EBMQueueService.resetForManualRetry(alert.queueId, companyId);
    alert.status = 'reset';
    alert.acknowledged = true;
    alert.acknowledgedAt = alert.acknowledgedAt || new Date();
    alert.resetAt = new Date();
    alert.resetBy = req.user?._id || req.user?.id || null;
    await alert.save();
    res.json({ success: true, data: { alert, queue: item } });
  } catch (error) {
    next(error);
  }
};

exports.getReadiness = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const branchId = String(req.query.branchId || req.query.bhfId || '00').padStart(2, '0').slice(-2);
    const data = await EBMReadinessService.getReadiness(companyId, branchId);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.syncSalesSummaries = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const result = await EBMSalesSyncService.syncSalesSummaries(companyId, {
      branchId: req.body.branchId || req.body.bhfId || '00',
      full: req.body.full === true,
      prcOrdCd: req.body.prcOrdCd,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

exports.syncRegisteredItems = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const result = await EBMItemSyncService.syncRegisteredItems(companyId, {
      branchId: req.body.branchId || req.body.bhfId || '00',
      full: req.body.full === true,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

