function toAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function idOf(value) {
  if (!value) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return String(value._id || value.id || '');
}

function fail(message, code = 'ERR_INVOICE_TAX_CORRECTION_INVALID') {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  throw error;
}

function buildInvoiceTaxCorrection(invoice, deliveryNote) {
  const invoiceLines = invoice?.lines || [];
  const deliveryLines = (deliveryNote?.lines || []).filter((line) =>
    toAmount(line.qtyToDeliver ?? line.deliveredQty) > 0,
  );
  if (!invoiceLines.length || invoiceLines.length !== deliveryLines.length) {
    fail('Invoice and delivery note lines do not match; tax correction was not applied.');
  }

  const unmatchedDeliveryLines = [...deliveryLines];
  const salesOrderLines = deliveryNote?.salesOrder?.lines || [];
  const correctedLines = [];
  for (const invoiceLine of invoiceLines) {
    const invoiceLineId = idOf(invoiceLine._id || invoiceLine.id);
    let matches = unmatchedDeliveryLines.filter((line) =>
      idOf(line.invoiceLineId) === invoiceLineId,
    );

    if (matches.length === 0) {
      const invoiceProductId = idOf(invoiceLine.product || invoiceLine.productId);
      const invoiceQty = toAmount(invoiceLine.qty ?? invoiceLine.quantity);
      matches = unmatchedDeliveryLines.filter((line) =>
        idOf(line.product || line.productId) === invoiceProductId
        && Math.abs(toAmount(line.qtyToDeliver ?? line.deliveredQty) - invoiceQty) < 0.0001,
      );
    }

    if (matches.length !== 1) {
      fail('Could not uniquely match every invoice line to its delivery note line.');
    }

    const [deliveryLine] = matches;
    unmatchedDeliveryLines.splice(unmatchedDeliveryLines.indexOf(deliveryLine), 1);
    const salesOrderLine = salesOrderLines.find((line) =>
      idOf(line._id || line.id) === idOf(deliveryLine.salesOrderLineId),
    );
    const qty = toAmount(deliveryLine.qtyToDeliver ?? deliveryLine.deliveredQty);
    const unitPrice = toAmount(deliveryLine.unitPrice ?? invoiceLine.unitPrice);
    const discountPct = toAmount(deliveryLine.discountPct);
    const subtotal = toAmount(deliveryLine.lineSubtotal)
      || Math.round(qty * unitPrice * (1 - discountPct / 100) * 100) / 100;
    const currentSubtotal = toAmount(invoiceLine.lineSubtotal)
      || Math.round(toAmount(invoiceLine.qty ?? invoiceLine.quantity) * toAmount(invoiceLine.unitPrice) * (1 - toAmount(invoiceLine.discountPct) / 100) * 100) / 100;

    if (Math.abs(subtotal - currentSubtotal) > 0.01) {
      fail('Delivery note subtotal differs from the confirmed invoice; use the credit-note workflow to correct the invoice.');
    }
    if (Math.abs(qty - toAmount(invoiceLine.qty ?? invoiceLine.quantity)) >= 0.0001) {
      fail('Invoice and delivery note quantities differ; tax correction was not applied.');
    }

    const taxRate = toAmount(
      salesOrderLine?.taxRate ?? deliveryLine.taxRate ?? deliveryLine.product?.taxRate ?? invoiceLine.taxRate,
    );
    const lineTax = toAmount(deliveryLine.lineTax)
      || Math.round(subtotal * taxRate / 100 * 100) / 100;
    const taxCode = salesOrderLine?.taxCode
      || salesOrderLine?.product?.taxCode
      || deliveryLine.product?.taxCode
      || deliveryLine.taxCode
      || invoiceLine.taxCode
      || 'A';
    correctedLines.push({
      id: invoiceLine._id || invoiceLine.id,
      lineSubtotal: subtotal,
      taxRate,
      taxCode,
      lineTax,
      lineTotal: subtotal + lineTax,
    });
  }

  if (unmatchedDeliveryLines.length > 0) {
    fail('Some delivery note lines do not match the invoice.');
  }

  const subtotal = correctedLines.reduce((sum, line) => sum + line.lineSubtotal, 0);
  const taxAmount = correctedLines.reduce((sum, line) => sum + line.lineTax, 0);
  const originalSubtotal = toAmount(invoice.subtotal);
  const originalTax = toAmount(invoice.taxAmount);
  if (Math.abs(subtotal - originalSubtotal) > 0.01) {
    fail('Invoice subtotal does not match its lines; tax correction was not applied.');
  }
  const originalLineTax = invoiceLines.reduce((sum, line) => sum + toAmount(line.lineTax), 0);
  if (Math.abs(originalLineTax - originalTax) > 0.01) {
    fail('Invoice header tax does not match its line tax; manual accounting review is required.');
  }

  return {
    lines: correctedLines,
    subtotal,
    taxAmount,
    totalAmount: subtotal + taxAmount,
    taxDelta: taxAmount - originalTax,
    originalTax,
    totalAEx: correctedLines.reduce((sum, line) => sum + (line.taxCode === 'A' ? line.lineSubtotal : 0), 0),
    totalB18: correctedLines.reduce((sum, line) => sum + (line.taxCode === 'B' ? line.lineSubtotal : 0), 0),
  };
}

module.exports = { buildInvoiceTaxCorrection };
