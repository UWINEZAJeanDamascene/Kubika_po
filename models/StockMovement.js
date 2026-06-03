const mongoose = require('mongoose');
const ebmSubmissionSchema = require('./schemas/ebmSubmissionSchema');

const stockMovementSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: false
  },
  company_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: false
  },
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: false
  },
  product_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: false
  },
  type: {
    type: String,
    enum: ['in', 'out', 'adjustment'],
    required: true
  },
  reason: {
    type: String,
    enum: [
      'purchase', 'sale', 'return', 'damage', 'loss', 
      'theft', 'expired', 'transfer_in', 'transfer_out', 'correction', 'initial_stock',
      'audit_surplus', 'audit_shortage', 'dispatch', 'dispatch_reversal'
    ],
    required: true
  },
  quantity: {
    type: mongoose.Schema.Types.Decimal128,
    required: false
  },
  previousStock: {
    type: mongoose.Schema.Types.Decimal128,
    required: false
  },
  newStock: {
    type: mongoose.Schema.Types.Decimal128,
    required: false
  },
  unitCost: {
    type: mongoose.Schema.Types.Decimal128,
    default: mongoose.Types.Decimal128.fromString('0.000000')
  },
  totalCost: {
    type: mongoose.Schema.Types.Decimal128,
    default: mongoose.Types.Decimal128.fromString('0.00')
  },
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier'
  },
  warehouse: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Warehouse'
  },
  batchNumber: String,
  lotNumber: String,
  expiryDate: Date,
  referenceType: {
    type: String,
    enum: ['purchase', 'purchase_order', 'invoice', 'adjustment', 'return', 'credit_note', 'other', 'delivery_note', 'stock_audit', 'opening_stock']
  },
  referenceNumber: String,
  referenceDocument: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'referenceModel'
  },
  referenceModel: {
    type: String,
    enum: ['Purchase', 'Invoice', 'PurchaseOrder', 'StockAdjustment', 'CreditNote', 'DeliveryNote', 'StockTransfer', 'StockAudit']
  },
  notes: String,
  performedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false
  },
  movementDate: {
    type: Date,
    default: Date.now
  },
  ebm: { type: ebmSubmissionSchema, default: () => ({}) }
}, {
  timestamps: true
});

// Indexes for efficient querying
stockMovementSchema.index({ company: 1 });
stockMovementSchema.index({ product: 1, movementDate: -1 });
stockMovementSchema.index({ supplier: 1, movementDate: -1 });
stockMovementSchema.index({ type: 1, movementDate: -1 });

// Performance indexes for reports
stockMovementSchema.index({ company: 1, type: 1 });
stockMovementSchema.index({ company: 1, reason: 1 });
stockMovementSchema.index({ company: 1, movementDate: 1 });
stockMovementSchema.index({ product: 1, type: 1 });
stockMovementSchema.index({ company_id: 1, type: 1, createdAt: -1 });
stockMovementSchema.index({ company_id: 1, product_id: 1, createdAt: -1 });
// Opening stock: enforce one-time entry per product per warehouse
stockMovementSchema.index(
  { company: 1, product: 1, warehouse: 1, reason: 1 },
  { unique: true, partialFilterExpression: { reason: 'initial_stock' } }
);

// Serialize Decimal128s as strings
stockMovementSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    const toQty = (v) => v == null ? '0.0000' : parseFloat(v.toString()).toFixed(4);
    const toMoney = (v) => v == null ? '0.00' : parseFloat(v.toString()).toFixed(2);
    if (ret.quantity !== undefined) ret.quantity = toQty(ret.quantity);
    if (ret.previousStock !== undefined) ret.previousStock = toQty(ret.previousStock);
    if (ret.newStock !== undefined) ret.newStock = toQty(ret.newStock);
    if (ret.unitCost !== undefined) ret.unitCost = toMoney(ret.unitCost);
    if (ret.totalCost !== undefined) ret.totalCost = toMoney(ret.totalCost);
    return ret;
  }
});

// Apply audit plugin
const auditPlugin = require('./plugins/auditSoftDeletePlugin');
stockMovementSchema.plugin(auditPlugin);

// Ensure compatibility with tests that set company_id/product_id
stockMovementSchema.pre('save', function(next) {
  if (!this.company && this.company_id) this.company = this.company_id
  if (!this.product && this.product_id) this.product = this.product_id
  next()
})

stockMovementSchema.post('save', function(doc) {
  setImmediate(() => {
    try {
      require('../services/autoPurchaseOrderService').handleStockMovementSaved(doc);
    } catch (error) {
      console.error('[AutoPO] Failed to schedule reorder check:', error.message);
    }
  });
});

// Convert Decimal128 results to JS numbers for compatibility with tests and lean queries
const decimalTransform = require('./plugins/decimalTransformPlugin');
stockMovementSchema.plugin(decimalTransform);

module.exports = mongoose.model('StockMovement', stockMovementSchema);
