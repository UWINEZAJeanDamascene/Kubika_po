const idOf = (value) => String(value?._id || value?.id || value || '');

function normalizeCreditNoteLines(invoice, requestedLines, type) {
  if (!Array.isArray(requestedLines) || requestedLines.length === 0) {
    const error = new Error('Add at least one invoice line and enter the quantity to credit.');
    error.statusCode = 422;
    throw error;
  }

  const creditLines = requestedLines.filter((line) => Number(line.quantity ?? line.qty) !== 0);
  if (creditLines.length === 0) {
    const error = new Error('Add at least one invoice line and enter the quantity to credit.');
    error.statusCode = 422;
    throw error;
  }

  const seen = new Set();
  return creditLines.map((requested) => {
    const invoiceLineId = idOf(requested.invoiceLineId);
    const invoiceLine = (invoice.lines || []).find((line) => idOf(line._id || line.id || line.lineId) === invoiceLineId);
    if (!invoiceLine) {
      const error = new Error('Every credit note line must reference a line on the selected original invoice.');
      error.statusCode = 422;
      throw error;
    }
    if (seen.has(invoiceLineId)) {
      const error = new Error('The same invoice line cannot appear more than once on a credit note.');
      error.statusCode = 422;
      throw error;
    }
    seen.add(invoiceLineId);

    const quantity = Number(requested.quantity ?? requested.qty);
    const originalQty = Number(invoiceLine.qty ?? invoiceLine.quantity ?? 0);
    const alreadyCredited = Number(invoiceLine.qtyCredited || 0);
    const remainingQty = Math.max(0, originalQty - alreadyCredited);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > remainingQty) {
      const error = new Error(`Credit quantity must be greater than zero and no more than the ${remainingQty} remaining on the invoice line.`);
      error.statusCode = 422;
      throw error;
    }

    const productId = idOf(invoiceLine.product);
    if (requested.product && idOf(requested.product) !== productId) {
      const error = new Error('The selected product does not match the original invoice line.');
      error.statusCode = 422;
      throw error;
    }
    const unitPrice = Number(invoiceLine.unitPrice || 0);
    const discountPct = Number(invoiceLine.discountPct || 0);
    const taxRate = Number(invoiceLine.taxRate || 0);
    const lineSubtotal = Math.round(quantity * unitPrice * (1 - discountPct / 100) * 100) / 100;
    const lineTax = Math.round(lineSubtotal * taxRate) / 100;
    const lineTotal = Math.round((lineSubtotal + lineTax) * 100) / 100;
    const unitCost = Number(invoiceLine.unitCost || 0);
    const product = invoiceLine.product && typeof invoiceLine.product === 'object' ? invoiceLine.product : null;
    const returnToWarehouse = requested.returnToWarehouse || requested.returnToWarehouseId || null;
    if (type === 'goods_return' && product?.isStockable !== false && !returnToWarehouse) {
      const error = new Error(`Select a return warehouse for ${invoiceLine.productName || product?.name || 'each stock item'}.`);
      error.statusCode = 422;
      throw error;
    }

    return {
      ...requested,
      invoiceLineId,
      product: productId,
      productName: invoiceLine.productName || invoiceLine.description || product?.name || null,
      quantity,
      originalQty,
      unitPrice,
      discountPct,
      unitCost,
      taxRate,
      lineSubtotal,
      lineTax,
      lineTotal,
      cogsAmount: Math.round(quantity * unitCost * 100) / 100,
      returnToWarehouse,
    };
  });
}

module.exports = { normalizeCreditNoteLines };
