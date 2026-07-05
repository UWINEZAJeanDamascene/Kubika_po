const EBM_STOCK_TYPE_CODES = Object.freeze({
  // RRA v1.0.5 Stock In/Out Type 01: Stock In (Purchase).
  // Imported goods confirmed into warehouse stock are purchase stock-in.
  IMPORT_CONFIRMED_STOCK_IN: '01',

  // RRA v1.0.5 Stock In/Out Type 01: Stock In (Purchase).
  GRN_PURCHASE_RECEIPT: '01',

  // RRA v1.0.5 Stock In/Out Type 02: Stock In (Return from customer).
  CUSTOMER_RETURN_IN: '02',

  // RRA v1.0.5 has no dedicated branch-transfer-in code; use Stock In (Other).
  BRANCH_TRANSFER_IN: '04',

  // RRA v1.0.5 has no dedicated adjustment-in code; use Stock In (Other).
  STOCK_ADJUSTMENT_IN: '04',

  // RRA v1.0.5 Stock In/Out Type 11: Stock Out (Sale).
  SALE_OUT: '11',

  // RRA v1.0.5 Stock In/Out Type 12: Stock Out (Return to supplier).
  SUPPLIER_RETURN_OUT: '12',

  // RRA v1.0.5 has no dedicated branch-transfer-out code; use Stock Out (Other).
  BRANCH_TRANSFER_OUT: '14',

  // RRA v1.0.5 Stock In/Out Type 13: Stock Out (Adjustment).
  STOCK_ADJUSTMENT_OUT: '13',

  // The VSDC code table has no dedicated opening-stock code in section 4.15.
  // Opening balances are reported as Stock In (Other).
  OPENING_STOCK: '04',
});

function getAdjustmentCode(direction) {
  return direction === 'in'
    ? EBM_STOCK_TYPE_CODES.STOCK_ADJUSTMENT_IN
    : EBM_STOCK_TYPE_CODES.STOCK_ADJUSTMENT_OUT;
}

module.exports = {
  EBM_STOCK_TYPE_CODES,
  getAdjustmentCode,
};
