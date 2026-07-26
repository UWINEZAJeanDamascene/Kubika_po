const EBM_SYNC_TYPES = Object.freeze({
  STANDARD_CODES: 'standard_codes',
  ITEM_CLASSES: 'item_classes',
  TINS: 'tins',
  BRANCHES: 'branches',
  NOTICES: 'notices',
  IMPORTED_ITEMS: 'imported_items',
  PURCHASE_SALES: 'purchase_sales',
  REGISTERED_ITEMS: 'registered_items',
  SALES_SUMMARY: 'sales_summary',
});

const EBM_CODE_SYNC_TYPES = Object.freeze([
  EBM_SYNC_TYPES.STANDARD_CODES,
  EBM_SYNC_TYPES.ITEM_CLASSES,
  EBM_SYNC_TYPES.TINS,
  EBM_SYNC_TYPES.BRANCHES,
  EBM_SYNC_TYPES.NOTICES,
]);

module.exports = {
  EBM_SYNC_TYPES,
  EBM_CODE_SYNC_TYPES,
};
