const { EBM_SYNC_TYPES } = require('../constants/ebmSyncTypes');

const SYNC_TYPE_LABELS = Object.freeze({
  [EBM_SYNC_TYPES.STANDARD_CODES]: 'Reference codes',
  [EBM_SYNC_TYPES.ITEM_CLASSES]: 'Item classes',
  [EBM_SYNC_TYPES.TINS]: 'Customer TINs',
  [EBM_SYNC_TYPES.BRANCHES]: 'Branches',
  [EBM_SYNC_TYPES.NOTICES]: 'RRA notices',
  [EBM_SYNC_TYPES.IMPORTED_ITEMS]: 'Imported items',
  [EBM_SYNC_TYPES.PURCHASE_SALES]: 'Purchase summaries',
  [EBM_SYNC_TYPES.REGISTERED_ITEMS]: 'Registered items',
  [EBM_SYNC_TYPES.SALES_SUMMARY]: 'Sales summaries',
});

const READINESS_ACTIONS = Object.freeze({
  company_tin: { actionLabel: 'Set company TIN', actionPath: '/company-settings' },
  device_initialized: { actionLabel: 'Initialize device', actionPath: '/company-settings' },
  branch_registered: { actionLabel: 'Manage branches', actionPath: '/warehouses' },
  codes_synced: { actionLabel: 'Sync codes now', actionPath: null, actionId: 'sync_codes' },
  products_registered: { actionLabel: 'Review products', actionPath: '/products?filter=ebm' },
});

function formatSyncStates(syncStates = [], branchId = '00') {
  return syncStates
    .filter((state) => String(state.branchId || '00') === String(branchId).padStart(2, '0').slice(-2))
    .map((state) => ({
      syncType: state.syncType,
      label: SYNC_TYPE_LABELS[state.syncType] || String(state.syncType || '').replace(/_/g, ' '),
      branchId: state.branchId,
      mode: state.mode,
      lastSyncedAt: state.lastSuccessfulSyncAt || null,
      lastAttemptAt: state.lastAttemptAt || null,
      lastErrorMessage: state.lastErrorMessage || null,
      summary: state.summary || {},
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

module.exports = {
  SYNC_TYPE_LABELS,
  READINESS_ACTIONS,
  formatSyncStates,
};
