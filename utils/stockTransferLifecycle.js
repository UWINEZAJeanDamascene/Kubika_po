function number(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw Object.assign(new Error(`${field} must be a non-negative number`), { code: 'INVALID_RECEIPT' });
  }
  return parsed;
}

function normalizeSerials(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().toUpperCase())
    .filter(Boolean))];
}

function identityKey(batch) {
  return `${String(batch.batchNumber || '').trim().toUpperCase()}|${String(batch.lotNumber || '').trim().toUpperCase()}`;
}

function buildReceiptPlan(lines, receiptLines) {
  if (!Array.isArray(receiptLines)) {
    throw Object.assign(new Error('Receipt must include each transfer line exactly once'), { code: 'INVALID_RECEIPT' });
  }
  const requested = new Map(receiptLines.map((line) => [String(line.lineId || line.transferLineId || ''), line]));
  if (requested.size !== receiptLines.length) {
    throw Object.assign(new Error('Receipt lines must be unique'), { code: 'INVALID_RECEIPT' });
  }
  if (receiptLines.length !== lines.length) {
    throw Object.assign(new Error('Receipt must include each transfer line exactly once'), { code: 'INVALID_RECEIPT' });
  }
  return lines.map((line) => {
    const receipt = requested.get(String(line._id || line.id));
    if (!receipt) throw Object.assign(new Error('Receipt is missing a transfer line'), { code: 'INVALID_RECEIPT' });
    const expectedQty = Number(line.qty?.toString?.() ?? line.qty ?? 0);
    const receivedQty = number(receipt.qtyReceived, 'qtyReceived');
    const shippedIdentity = line.inventoryIdentity || {};
    const receivedIdentity = receipt.identity || {};
    const varianceQty = receivedQty - expectedQty;
    let serialNumbers = normalizeSerials(receivedIdentity.serialNumbers ?? receipt.serialNumbers);
    if (line.trackSerialNumbers) {
      if (!Number.isInteger(receivedQty) || serialNumbers.length !== receivedQty) {
        throw Object.assign(new Error('Received serial count must equal received quantity'), { code: 'INVALID_RECEIPT_IDENTITY' });
      }
      const shippedSerials = normalizeSerials(shippedIdentity.serialNumbers);
      if (receivedQty <= expectedQty && serialNumbers.some((serial) => !shippedSerials.includes(serial))) {
        throw Object.assign(new Error('Received serials must match the dispatched serials'), { code: 'INVALID_RECEIPT_IDENTITY' });
      }
    } else {
      serialNumbers = [];
    }

    let batches = Array.isArray(receivedIdentity.batches) ? receivedIdentity.batches : receipt.batches;
    if (line.trackBatch) {
      if (!Array.isArray(batches)) {
        throw Object.assign(new Error('Received batch identity is required'), { code: 'INVALID_RECEIPT_IDENTITY' });
      }
      batches = batches.map((batch) => ({
        batchNumber: String(batch.batchNumber || '').trim(),
        lotNumber: String(batch.lotNumber || '').trim(),
        quantity: number(batch.quantity, 'batch quantity'),
      }));
      const batchQty = batches.reduce((sum, batch) => sum + batch.quantity, 0);
      if (Math.abs(batchQty - receivedQty) > 0.0001) {
        throw Object.assign(new Error('Received batch quantities must equal received quantity'), { code: 'INVALID_RECEIPT_IDENTITY' });
      }
      const shipped = new Map((shippedIdentity.batches || []).map((batch) => [
        identityKey(batch),
        Number(batch.quantity || 0),
      ]));
      const receivedByKey = new Map();
      for (const batch of batches) {
        const key = identityKey(batch);
        receivedByKey.set(key, (receivedByKey.get(key) || 0) + batch.quantity);
      }
      if (receivedQty <= expectedQty && [...receivedByKey].some(([key, qty]) => qty > (shipped.get(key) || 0) + 0.0001)) {
        throw Object.assign(new Error('Received batches must match the dispatched batches'), { code: 'INVALID_RECEIPT_IDENTITY' });
      }
    } else {
      batches = [];
    }

    return {
      line,
      receipt,
      expectedQty,
      receivedQty,
      varianceQty,
      serialNumbers,
      batches,
      receivedIdentity: { serialNumbers, batches },
    };
  });
}

module.exports = { buildReceiptPlan, normalizeSerials };
