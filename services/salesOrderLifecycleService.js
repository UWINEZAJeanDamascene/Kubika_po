const SalesOrder = require('../models/SalesOrder');
const DeliveryNote = require('../models/DeliveryNote');
const Invoice = require('../models/Invoice');
const Product = require('../models/Product');

const STATUS_RANK = {
  draft: 0,
  confirmed: 1,
  picking: 2,
  packed: 3,
  delivered: 4,
  invoiced: 5,
  closed: 6,
};

function deriveSalesOrderStatus(currentStatus, deliveryStatuses, invoiceStatuses, isFullyFulfilled = true) {
  if (currentStatus === 'cancelled' || currentStatus === 'closed') return currentStatus;
  if (!isFullyFulfilled) return currentStatus;

  const activeDeliveries = deliveryStatuses.filter((status) => status !== 'cancelled');
  if (activeDeliveries.length === 0 || !activeDeliveries.every((status) => status === 'delivered')) {
    return currentStatus;
  }

  const activeInvoices = invoiceStatuses.filter((status) => status !== 'cancelled');
  const nextStatus = activeInvoices.length === 0
    ? 'delivered'
    : activeInvoices.every((status) => status === 'fully_paid')
      ? 'closed'
      : 'invoiced';

  return (STATUS_RANK[nextStatus] ?? -1) > (STATUS_RANK[currentStatus] ?? -1)
    ? nextStatus
    : currentStatus;
}

async function syncSalesOrderLifecycle(salesOrderId, companyId) {
  const normalizedId = salesOrderId?._id || salesOrderId?.id || salesOrderId;
  if (!normalizedId || !companyId) return null;

  const [salesOrder, deliveryNotes, invoices] = await Promise.all([
    SalesOrder.findOne({ _id: normalizedId, company: companyId })
      .select({ status: 1, lines: 1, isBackorder: 1, fulfillmentStatus: 1, fulfillmentPercent: 1 })
      .lean(),
    DeliveryNote.find({ salesOrder: normalizedId, company: companyId })
      .select({ status: 1, lines: 1 })
      .lean(),
    Invoice.find({ salesOrder: normalizedId, company: companyId })
      .select({ status: 1 })
      .lean(),
  ]);

  if (!salesOrder) return null;

  const orderLines = salesOrder.lines || [];
  const productIds = [...new Set(orderLines.map((line) => String(line.product?._id || line.product?.id || line.product || '')).filter(Boolean))];
  const products = productIds.length
    ? await Product.find({ _id: { $in: productIds }, company: companyId }).select({ isStockable: 1 }).lean()
    : [];
  const stockableProductIds = new Set(products.filter((product) => product.isStockable !== false).map((product) => String(product._id)));
  const lineById = new Map(orderLines.map((line, index) => [String(line._id || line.id || line.lineId || index), line]));
  const deliveredByLine = new Map();
  for (const note of deliveryNotes) {
    if (note.status !== 'delivered') continue;
    for (const line of note.lines || []) {
      const productId = String(line.product?._id || line.product?.id || line.product || '');
      const delivered = Number(line.deliveredQty) || Number(line.qtyToDeliver) || 0;
      let orderLine = lineById.get(String(line.salesOrderLineId || ''));
      // Backward compatibility for delivery notes created before line links existed.
      if (!orderLine) orderLine = orderLines.find((candidate) => {
        const candidateId = String(candidate._id || candidate.id || candidate.lineId || '');
        return String(candidate.product?._id || candidate.product?.id || candidate.product || '') === productId
          && stockableProductIds.has(productId)
          && (deliveredByLine.get(candidateId) || 0) < Number(candidate.qty || 0);
      });
      if (!orderLine) continue;
      const id = String(orderLine._id || orderLine.id || orderLine.lineId || '');
      deliveredByLine.set(id, (deliveredByLine.get(id) || 0) + delivered);
    }
  }
  const stockableLines = orderLines.filter((line) => stockableProductIds.has(String(line.product?._id || line.product?.id || line.product || '')));
  const orderedQty = stockableLines.reduce((sum, line) => sum + (Number(line.qty) || 0), 0);
  const deliveredQty = stockableLines.reduce((sum, line) => {
    const id = String(line._id || line.id || line.lineId || '');
    return sum + Math.min(Number(line.qty) || 0, deliveredByLine.get(id) || 0);
  }, 0);
  const isFullyFulfilled = orderedQty === 0 || deliveredQty >= orderedQty;
  const fulfillmentPercent = orderedQty > 0 ? Math.min(100, Math.round((deliveredQty / orderedQty) * 10000) / 100) : 100;
  const fulfillmentStatus = isFullyFulfilled ? 'fulfilled' : deliveredQty > 0 ? 'partial' : 'pending';
  const hasBackorder = stockableLines.some((line) => Number(line.qty || 0) - Number(line.qtyShipped || 0) > 0);

  let nextStatus = deriveSalesOrderStatus(
    salesOrder.status,
    deliveryNotes.map((note) => note.status),
    invoices.map((invoice) => invoice.status),
    isFullyFulfilled,
  );
  const activeDeliveryStatuses = deliveryNotes.filter((note) => note.status !== 'cancelled').map((note) => note.status);
  if (!isFullyFulfilled && deliveredQty > 0 && activeDeliveryStatuses.length > 0 && activeDeliveryStatuses.every((status) => status === 'delivered')) {
    nextStatus = 'confirmed';
  }
  if (nextStatus === salesOrder.status
    && Number(salesOrder.fulfillmentPercent || 0) === fulfillmentPercent
    && salesOrder.fulfillmentStatus === fulfillmentStatus
    && salesOrder.isBackorder === hasBackorder) return salesOrder;

  return SalesOrder.findOneAndUpdate(
    { _id: normalizedId, company: companyId, status: salesOrder.status },
    { $set: { status: nextStatus, fulfillmentStatus, fulfillmentPercent, isBackorder: hasBackorder } },
    { new: true },
  );
}

module.exports = { deriveSalesOrderStatus, syncSalesOrderLifecycle };
