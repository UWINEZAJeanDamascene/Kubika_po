/**
 * PickPack — PostgreSQL (Prisma) backed.
 */

const { buildDocumentModel, buildLineInclude } = require('../utils/salesApCommon');
const {
  pickPackToApi,
  pickPackTranslateCreate,
  pickPackTranslateUpdate,
} = require('../utils/salesApMappers');

const FIELD_MAP = {
  referenceNo: { target: 'referenceNo' },
  salesOrder: { target: 'salesOrderId', isId: true },
  client: { target: 'clientId', isId: true },
  warehouse: { target: 'warehouseId', isId: true },
  status: { target: 'status' },
  assignedTo: { target: 'assignedToId', isId: true },
  deliveryNote: { target: 'deliveryNoteId', isId: true },
  priority: { target: 'priority' },
};

const VALID_TRANSITIONS = {
  draft: ['picking', 'cancelled'],
  picking: ['picked', 'cancelled'],
  picked: ['packed', 'cancelled'],
  packed: ['ready_for_delivery', 'cancelled'],
  ready_for_delivery: ['cancelled'],
  cancelled: [],
};

const SO_STATUS_MAP = {
  draft: 'confirmed',
  picking: 'picking',
  picked: 'picking',
  packed: 'packed',
  ready_for_delivery: 'packed',
  cancelled: 'confirmed',
};

function deriveLineStatuses(doc) {
  if (!Array.isArray(doc.lines)) return;
  for (const line of doc.lines) {
    const toPick = Number(line.qtyToPick) || 0;
    const picked = Number(line.qtyPicked) || 0;
    const packed = Number(line.qtyPacked) || 0;
    const issues = line.issues || [];
    if (issues.length > 0 && !issues.every((i) => i.resolved)) {
      line.status = 'issue';
    } else if (packed >= toPick && toPick > 0) {
      line.status = 'packed';
    } else if (picked >= toPick && toPick > 0) {
      line.status = 'picked';
    } else if (picked > 0) {
      line.status = 'picking';
    } else {
      line.status = 'pending';
    }
  }
}

/** Force a new lines array so Prisma shim rewrites child rows (in-place edits). */
function markLinesDirty(doc) {
  if (!Array.isArray(doc.lines)) return;
  doc.lines = doc.lines.map((line) => {
    const next = { ...line };
    if (next.product && typeof next.product === 'object') {
      next.product = next.product._id || next.product.id;
    }
    if (next.warehouse && typeof next.warehouse === 'object') {
      next.warehouse = next.warehouse._id || next.warehouse.id;
    }
    return next;
  });
}

async function syncSalesOrderStatus(doc, { prevStatus } = {}) {
  if (!doc.status || doc.status === prevStatus) return;
  const targetStatus = SO_STATUS_MAP[doc.status];
  if (!targetStatus) return;

  const SalesOrder = require('./SalesOrder');
  const salesOrderId = doc.salesOrder?._id || doc.salesOrder?.id || doc.salesOrder;
  if (!salesOrderId) return;

  const salesOrder = await SalesOrder.findById(salesOrderId);
  if (!salesOrder) return;
  if (typeof salesOrder.canTransitionTo === 'function' && !salesOrder.canTransitionTo(targetStatus)) {
    return;
  }
  salesOrder.status = targetStatus;
  await salesOrder.save();
}

module.exports = buildDocumentModel({
  name: 'PickPack',
  collection: 'pickpacks',
  delegateName: 'pickPack',
  fieldMap: FIELD_MAP,
  toApi: pickPackToApi,
  translateCreate: pickPackTranslateCreate,
  translateUpdate: pickPackTranslateUpdate,
  include: buildLineInclude(),
  beforeSave: async (doc) => {
    deriveLineStatuses(doc);
    // Only rewrite lines when we still have them — never force an empty rewrite.
    if (Array.isArray(doc.lines) && doc.lines.length > 0) {
      markLinesDirty(doc);
    }
  },
  afterSave: syncSalesOrderStatus,
  instanceMethods: {
    canTransitionTo(newStatus) {
      return VALID_TRANSITIONS[this.status]?.includes(newStatus) || false;
    },
    canEdit() {
      return ['draft', 'picking', 'picked', 'packed'].includes(this.status);
    },
    isFullyPicked() {
      return (this.lines || []).every((line) => (line.qtyPicked || 0) >= (line.qtyToPick || 0));
    },
    isFullyPacked() {
      return (this.lines || []).every((line) => (line.qtyPacked || 0) >= (line.qtyToPick || 0));
    },
    getPickProgress() {
      let totalToPick = 0;
      let totalPicked = 0;
      for (const line of this.lines || []) {
        totalToPick += line.qtyToPick || 0;
        totalPicked += line.qtyPicked || 0;
      }
      return totalToPick > 0 ? Math.round((totalPicked / totalToPick) * 100) : 0;
    },
    getPackProgress() {
      let totalToPack = 0;
      let totalPacked = 0;
      for (const line of this.lines || []) {
        totalToPack += line.qtyToPick || 0;
        totalPacked += line.qtyPacked || 0;
      }
      return totalToPack > 0 ? Math.round((totalPacked / totalToPack) * 100) : 0;
    },
  },
});
