/**
 * ReportSnapshot — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  reportSnapshotToApi,
  reportSnapshotTranslateCreate,
  reportSnapshotTranslateUpdate,
} = require('../utils/bankingMappers');

const FIELD_MAP = {
  reportType: { target: 'reportType' },
  periodType: { target: 'periodType' },
  periodStart: { target: 'periodStart' },
  periodEnd: { target: 'periodEnd' },
  periodLabel: { target: 'periodLabel' },
  year: { target: 'year' },
  periodNumber: { target: 'periodNumber' },
  status: { target: 'status' },
  generatedAt: { target: 'generatedAt' },
  generatedBy: { target: 'generatedById', isId: true },
};

const ReportSnapshot = buildTenantModel({
  name: 'ReportSnapshot',
  collection: 'reportsnapshots',
  delegateName: 'reportSnapshot',
  fieldMap: FIELD_MAP,
  toApi: reportSnapshotToApi,
  translateCreate: reportSnapshotTranslateCreate,
  translateUpdate: reportSnapshotTranslateUpdate,
  mutable: true,
});

ReportSnapshot.getSnapshot = async function getSnapshot(companyId, periodType, year, periodNumber) {
  return this.findOne({
    company: companyId,
    periodType,
    year,
    periodNumber,
    status: 'completed',
  }).sort({ generatedAt: -1 });
};

ReportSnapshot.getAvailablePeriods = async function getAvailablePeriods(companyId, periodType, limit = 24) {
  return this.find({
    company: companyId,
    periodType,
    status: 'completed',
  })
    .sort({ year: -1, periodNumber: -1 })
    .limit(limit)
    .select('periodLabel year periodNumber periodStart periodEnd generatedAt summary');
};

ReportSnapshot.cleanOldSnapshots = async function cleanOldSnapshots(companyId) {
  const retentionRules = {
    daily: 7,
    weekly: 52,
    monthly: 24,
    quarterly: 8,
    'semi-annual': 4,
    annual: 999,
  };

  for (const [period, retention] of Object.entries(retentionRules)) {
    const cutoffDate = new Date();
    if (period === 'daily') {
      cutoffDate.setDate(cutoffDate.getDate() - retention);
    } else if (period === 'weekly') {
      cutoffDate.setDate(cutoffDate.getDate() - (retention * 7));
    } else if (period === 'monthly') {
      cutoffDate.setMonth(cutoffDate.getMonth() - retention);
    } else if (period === 'quarterly') {
      cutoffDate.setMonth(cutoffDate.getMonth() - (retention * 3));
    } else if (period === 'semi-annual') {
      cutoffDate.setMonth(cutoffDate.getMonth() - (retention * 6));
    } else {
      continue;
    }

    await this.deleteMany({
      company: companyId,
      periodType: period,
      generatedAt: { $lt: cutoffDate },
    });
  }
};

module.exports = ReportSnapshot;
