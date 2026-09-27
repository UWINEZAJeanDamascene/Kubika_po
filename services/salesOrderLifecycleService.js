const SalesOrder = require('../models/SalesOrder');
const DeliveryNote = require('../models/DeliveryNote');
const Invoice = require('../models/Invoice');

const STATUS_RANK = {
  draft: 0,
  confirmed: 1,
  picking: 2,
  packed: 3,
  delivered: 4,
  invoiced: 5,
  closed: 6,
};

function deriveSalesOrderStatus(currentStatus, deliveryStatuses, invoiceStatuses) {
  if (currentStatus === 'cancelled' || currentStatus === 'closed') return currentStatus;

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
      .select({ status: 1 })
      .lean(),
    DeliveryNote.find({ salesOrder: normalizedId, company: companyId })
      .select({ status: 1 })
      .lean(),
    Invoice.find({ salesOrder: normalizedId, company: companyId })
      .select({ status: 1 })
      .lean(),
  ]);

  if (!salesOrder) return null;

  const nextStatus = deriveSalesOrderStatus(
    salesOrder.status,
    deliveryNotes.map((note) => note.status),
    invoices.map((invoice) => invoice.status),
  );
  if (nextStatus === salesOrder.status) return salesOrder;

  return SalesOrder.findOneAndUpdate(
    { _id: normalizedId, company: companyId, status: salesOrder.status },
    { $set: { status: nextStatus } },
    { new: true },
  );
}

module.exports = { deriveSalesOrderStatus, syncSalesOrderLifecycle };