const mongoose = require('mongoose');
const { generateUniqueCode, generateSKU } = require('./utils/autoIncrement');

const productHistorySchema = new mongoose.Schema({
  action: {
    type: String,
    enum: ['created', 'updated', 'archived', 'restored'],
    required: true
  },
  changes: {
    type: mongoose.Schema.Types.Mixed
  },
  changedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  notes: String
});

const productSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Product must belong to a company']
  },
  name: {
    type: String,
    required: [true, 'Please provide a product name'],
    trim: true
  },
  sku: {
    type: String,
    required: [true, 'Please provide a SKU'],
    uppercase: true,
    trim: true
  },
  // Barcode fields
  barcode: {
    type: String,
    trim: true,
    default: null
  },
  barcodeType: {
    type: String,
    enum: ['CODE128', 'EAN13', 'EAN8', 'UPC', 'CODE39', 'ITF14', 'QR', 'NONE'],
    default: 'CODE128'
  },
  description: {
    type: String,
    trim: true
  },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category',
    required: [true, 'Please provide a category']
  },
  unit: {
    type: String,
    required: [true, 'Please provide a unit of measurement'],
    default: 'pcs'
  },
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier'
  },
  currentStock: {
    type: mongoose.Schema.Types.Decimal128,
    default: mongoose.Types.Decimal128.fromString('0.0000')
  },
  reservedQuantity: {
    type: mongoose.Schema.Types.Decimal128,
    default: mongoose.Types.Decimal128.fromString('0.0000')
  },
  // Active flag: soft-delete control
  isActive: {
    type: Boolean,
    default: true
  },
  // Whether inventory journals should be generated for this product
  isStockable: {
    type: Boolean,
    default: true
  },
  lowStockThreshold: {
    type: mongoose.Schema.Types.Decimal128,
    default: mongoose.Types.Decimal128.fromString('10.0000')
  },
  averageCost: {
    type: mongoose.Schema.Types.Decimal128,
    default: mongoose.Types.Decimal128.fromString('0.00'),
    get: v => (v == null ? '0.00' : (typeof v === 'string' ? v : (v.toString())) )
  },
  sellingPrice: {
    type: mongoose.Schema.Types.Decimal128,
    default: mongoose.Types.Decimal128.fromString('0.00'),
    get: v => (v == null ? '0.00' : (typeof v === 'string' ? v : (v.toString())) )
  },
  lastSupplyDate: {
    type: Date
  },
  lastSaleDate: {
    type: Date
  },
  // Fallback cost price (not authoritative)
  costPrice: {
    type: mongoose.Schema.Types.Decimal128,
    default: mongoose.Types.Decimal128.fromString('0.00')
  },
  // Costing method
  costingMethod: {
    type: String,
    enum: ['fifo', 'weighted', 'wac', 'avg'],
    default: 'fifo'
  },
  // Accounting mappings (store account codes)
  inventoryAccount: {
    type: String
  },
  cogsAccount: {
    type: String
  },
  revenueAccount: {
    type: String
  },
  isArchived: {
    type: Boolean,
    default: false
  },
  // Additional product attributes
  weight: {
    type: Number,
    default: 0,
    min: 0
  },
  brand: {
    type: String,
    trim: true
  },
  location: {
    type: String,
    trim: true
  },
  // Advanced inventory tracking - tracking_type replaces trackBatch/trackSerialNumbers
  trackingType: {
    type: String,
    enum: ['none', 'batch', 'serial'],
    default: 'none'
  },
  // Legacy tracking flags (deprecated - use trackingType)
  trackBatch: {
    type: Boolean,
    default: false
  },
  trackSerialNumbers: {
    type: Boolean,
    default: false
  },
  // Reorder settings
  reorderPoint: {
    type: mongoose.Schema.Types.Decimal128,
    default: mongoose.Types.Decimal128.fromString('0.0000')
  },
  reorderQuantity: {
    type: mongoose.Schema.Types.Decimal128,
    default: mongoose.Types.Decimal128.fromString('0.0000')
  },
  // Multiple warehouse support - store default warehouse
  defaultWarehouse: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Warehouse'
  },
  // Preferred supplier for reordering
  preferredSupplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier'
  },
  // Tax settings: product-level default tax code and rate
  taxCode: {
    type: String,
    default: 'A'
  },
  taxRate: {
    type: mongoose.Schema.Types.Decimal128,
    default: mongoose.Types.Decimal128.fromString('0.000000')
  },
  ebm: {
    itemClassCd: { type: String, trim: true, default: null },
    taxTyCd: { type: String, trim: true, enum: ['A', 'B', 'C', 'D', null], default: null },
    pkgUnitCd: { type: String, trim: true, default: null },
    qtyUnitCd: { type: String, trim: true, default: null },
    itemTyCd: { type: String, trim: true, default: null },
    orgnNatCd: { type: String, trim: true, default: null },
    itemStdNm: { type: String, trim: true, default: null },
    btchNo: { type: String, trim: true, default: null },
    addInfo: { type: String, trim: true, default: null },
    sftyQty: {
      type: mongoose.Schema.Types.Decimal128,
      default: null,
      get: v => (v == null ? null : (typeof v === 'string' ? v : v.toString()))
    },
    isrcAplcbYn: { type: String, trim: true, enum: ['Y', 'N', null], default: null },
    isRegisteredWithEBM: { type: Boolean, default: false },
    ebmRegisteredAt: { type: Date, default: null },
    ebmLastAttemptAt: { type: Date, default: null },
    ebmRegistrationError: { type: String, trim: true, default: null },
    ebmItemCode: { type: String, trim: true, default: null },
    registeredWithRra: { type: Boolean, default: false },
    registeredAt: { type: Date, default: null },
    itemClassCode: { type: String, trim: true, default: null },
    taxTypeCode: { type: String, trim: true, default: null },
    packagingUnitCode: { type: String, trim: true, default: null },
    quantityUnitCode: { type: String, trim: true, default: null }
  },
  history: [productHistorySchema],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  customFields: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// Compound index for company + unique sku
productSchema.index({ company: 1, sku: 1 }, { unique: true });
// Index for searching
productSchema.index({ name: 'text', sku: 'text', description: 'text' });
// Index for company filtering
productSchema.index({ company: 1 });

// Performance indexes for reports and queries
productSchema.index({ company: 1, category: 1 });
productSchema.index({ company: 1, isArchived: 1 });
productSchema.index({ company: 1, currentStock: 1 });
productSchema.index({ supplier: 1 });

// Virtual for low stock alert
productSchema.virtual('isLowStock').get(function() {
  try {
    const cs = this.currentStock && this.currentStock.toString ? parseFloat(this.currentStock.toString()) : Number(this.currentStock || 0);
    const th = this.lowStockThreshold && this.lowStockThreshold.toString ? parseFloat(this.lowStockThreshold.toString()) : Number(this.lowStockThreshold || 0);
    return cs <= th;
  } catch (e) {
    return false;
  }
});

// Virtual for available stock (current - reserved)
productSchema.virtual('availableStock').get(function() {
  try {
    const cs = this.currentStock && this.currentStock.toString ? parseFloat(this.currentStock.toString()) : Number(this.currentStock || 0);
    const rs = this.reservedQuantity && this.reservedQuantity.toString ? parseFloat(this.reservedQuantity.toString()) : Number(this.reservedQuantity || 0);
    return Math.max(0, cs - rs);
  } catch (e) {
    return Number(this.currentStock || 0);
  }
});

// Add history entry before save
// Before validation, auto-generate SKU if missing using product name
productSchema.pre('validate', async function(next) {
  if (this.isNew) {
    if (!this.sku || String(this.sku).trim() === '') {
      // Derive prefix from product name: prefer acronym of capital letters (e.g., "Personal Computer" -> PC)
      // Fallback: first three letters of name (e.g., "Laptop" -> LAP)
      const name = String(this.name || '').trim();
      let prefix = '';
      const caps = name.match(/[A-Z]/g);
      if (caps && caps.length >= 2) {
        prefix = (caps[0] + caps[1]).toUpperCase();
      } else {
        // take first three alpha characters
        const letters = name.replace(/[^A-Za-z]/g, '').toUpperCase();
        prefix = letters.substring(0, 3) || 'PRD';
      }

      // Generate SKU as PREFIX-001
      this.sku = await generateSKU(prefix, mongoose.model('Product'), this.company, 'sku', 3, true);
    }
  }
  next();
});

// After validation, ensure uniqueness/conflicts handled before save
productSchema.pre('save', async function(next) {
  if (this.isNew) {
    // If SKU conflicts (rare), fallback to generic unique code
    if (this.sku) {
      const existing = await mongoose.model('Product').findOne({
        company: this.company,
        sku: this.sku.toUpperCase()
      });
      
      if (existing) {
        this.sku = await generateUniqueCode('PRD', mongoose.model('Product'), this.company, 'sku');
      }
    }

    // Only record creation history when we have a creator reference.
    if (this.createdBy) {
      this.history.push({
        action: 'created',
        changedBy: this.createdBy,
        changes: this.toObject()
      });
    }
  }
  next();
});

// Ensure Decimal128 fields serialize as string amounts in JSON
// Ensure Decimal128 fields serialize as strings
productSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    const toMoney = (val) => {
      if (val == null) return '0.00';
      try { return parseFloat(val.toString()).toFixed(2); } catch (e) { return String(val); }
    };
    const toQty = (val) => {
      if (val == null) return '0.0000';
      try { return parseFloat(val.toString()).toFixed(4); } catch (e) { return String(val); }
    };
    if (ret.averageCost !== undefined) ret.averageCost = toMoney(ret.averageCost);
    if (ret.sellingPrice !== undefined) ret.sellingPrice = toMoney(ret.sellingPrice);
    if (ret.costPrice !== undefined) ret.costPrice = toMoney(ret.costPrice);
    if (ret.currentStock !== undefined) ret.currentStock = toQty(ret.currentStock);
    if (ret.reservedQuantity !== undefined) ret.reservedQuantity = toQty(ret.reservedQuantity);
    if (ret.lowStockThreshold !== undefined) ret.lowStockThreshold = toQty(ret.lowStockThreshold);
    if (ret.reorderPoint !== undefined) ret.reorderPoint = toQty(ret.reorderPoint);
    if (ret.reorderQuantity !== undefined) ret.reorderQuantity = toQty(ret.reorderQuantity);
    if (ret.taxRate !== undefined) ret.taxRate = (ret.taxRate == null) ? '0.000000' : parseFloat(ret.taxRate.toString()).toFixed(6);
    return ret;
  }
});

productSchema.set('toObject', { virtuals: true });

// Legacy field compatibility virtuals
productSchema.virtual('cost').get(function() {
  try {
    const v = this.costPrice;
    return v && v.toString ? parseFloat(v.toString()) : Number(v || 0);
  } catch (e) {
    return Number(this.costPrice || 0);
  }
}).set(function(val) {
  // Accept number or Decimal-like
  this.costPrice = (val && val.toString) ? mongoose.Types.Decimal128.fromString(parseFloat(val).toFixed(2)) : val;
});

productSchema.virtual('avgCost').get(function() {
  try {
    const v = this.averageCost;
    return v && v.toString ? parseFloat(v.toString()) : Number(v || 0);
  } catch (e) {
    return Number(this.averageCost || 0);
  }
}).set(function(val) {
  this.averageCost = (val && val.toString) ? mongoose.Types.Decimal128.fromString(parseFloat(val).toFixed(2)) : val;
});

productSchema.virtual('costMethod').get(function() {
  return this.costingMethod;
}).set(function(val) {
  this.costingMethod = val;
});

// Apply audit/soft-delete plugin
const auditPlugin = require('./plugins/auditSoftDeletePlugin');
productSchema.plugin(auditPlugin);

// Convert Decimal128 results to JS numbers for compatibility with tests and lean queries
const decimalTransform = require('./plugins/decimalTransformPlugin');
productSchema.plugin(decimalTransform);

module.exports = mongoose.model('Product', productSchema);
