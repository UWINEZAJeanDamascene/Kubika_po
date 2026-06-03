const mongoose = require('mongoose');
const { generateUniqueNumber } = require('./utils/autoIncrement');
const decimalTransform = require('./plugins/decimalTransformPlugin');

const quotationLineSchema = new mongoose.Schema({
  // Line ID for identification
  lineId: {
    type: String,
    default: () => new mongoose.Types.ObjectId().toString()
  },
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: [true, 'Product is required for quotation line']
  },
  // Snapshot fields to prevent drift when products change
  productName: { type: String, default: null },
  productSku: { type: String, default: null },
  productUnit: { type: String, default: null },
  description: {
    type: String,
    default: null
  },
  // Quantity
  qty: {
    type: mongoose.Schema.Types.Decimal128,
    required: [true, 'Quantity is required'],
    get: v => (v == null ? 0 : parseFloat(v.toString())),
    min: [0.0001, 'Quantity must be greater than 0']
  },
  // Unit of measure
  unit: {
    type: String,
    default: null
  },
  // Quoted selling price
  unitPrice: {
    type: mongoose.Schema.Types.Decimal128,
    required: [true, 'Unit price is required'],
    get: v => (v == null ? 0 : parseFloat(v.toString())),
    min: [0, 'Unit price cannot be negative']
  },
  // Line discount percentage
  discountPct: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0,
    get: v => (v == null ? 0 : parseFloat(v.toString())),
    min: [0, 'Discount percentage cannot be negative'],
    max: [100, 'Discount percentage cannot exceed 100']
  },
  // Tax rate percentage
  taxRate: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0,
    get: v => (v == null ? 0 : parseFloat(v.toString())),
    min: [0, 'Tax rate cannot be negative'],
    max: [100, 'Tax rate cannot exceed 100']
  },
  // Derived amounts in quote currency
  lineSubtotal: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0,
    get: v => (v == null ? 0 : parseFloat(v.toString()))
  },
  lineDiscount: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0,
    get: v => (v == null ? 0 : parseFloat(v.toString()))
  },
  // Line total: qty × unitPrice × (1 − discountPct/100)
  lineTotal: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0,
    get: v => (v == null ? 0 : parseFloat(v.toString()))
  },
  // Line tax amount
  lineTax: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0,
    get: v => (v == null ? 0 : parseFloat(v.toString()))
  },
  // Base currency equivalents
  lineSubtotalBase: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0,
    get: v => (v == null ? 0 : parseFloat(v.toString()))
  },
  lineDiscountBase: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0,
    get: v => (v == null ? 0 : parseFloat(v.toString()))
  },
  lineTotalBase: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0,
    get: v => (v == null ? 0 : parseFloat(v.toString()))
  },
  lineTaxBase: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0,
    get: v => (v == null ? 0 : parseFloat(v.toString()))
  }
}, {
  _id: false // Don't create separate _id for each line
});

const quotationSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Quotation must belong to a company']
  },
  // Reference number: QUO-YYYY-NNNNN
  referenceNo: {
    type: String,
    uppercase: true
  },
  // Client/Customer
  client: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: [true, 'Client is required']
  },
  // Quotation date
  quotationDate: {
    type: Date,
    default: Date.now
  },
  // Expiry date - after this, quotation is expired
  expiryDate: {
    type: Date,
    required: [true, 'Expiry date is required']
  },
  // Status: draft, sent, accepted, rejected, expired, converted
  status: {
    type: String,
    enum: ['draft', 'pending_approval', 'sent', 'accepted', 'rejected', 'expired', 'converted'],
    default: 'draft'
  },
  // Currency
  currencyCode: {
    type: String,
    required: [true, 'Currency code is required'],
    default: 'USD',
    uppercase: true,
    maxlength: 3
  },
  baseCurrency: {
    type: String,
    uppercase: true,
    maxlength: 3
  },
  // Exchange rate to company base currency
  exchangeRate: {
    type: mongoose.Schema.Types.Decimal128,
    default: 1,
    get: v => (v == null ? 1 : parseFloat(v.toString())),
    min: [0.000001, 'Exchange rate must be positive']
  },
  // Quotation lines
  lines: [quotationLineSchema],
  // Subtotal (before tax)
  subtotal: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0,
    get: v => (v == null ? 0 : parseFloat(v.toString()))
  },
  // Total discount amount
  totalDiscount: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0,
    get: v => (v == null ? 0 : parseFloat(v.toString()))
  },
  // Total tax amount
  taxAmount: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0,
    get: v => (v == null ? 0 : parseFloat(v.toString()))
  },
  // Grand total
  totalAmount: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0,
    get: v => (v == null ? 0 : parseFloat(v.toString()))
  },
  // Base currency totals
  subtotalBase: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0,
    get: v => (v == null ? 0 : parseFloat(v.toString()))
  },
  totalDiscountBase: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0,
    get: v => (v == null ? 0 : parseFloat(v.toString()))
  },
  taxAmountBase: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0,
    get: v => (v == null ? 0 : parseFloat(v.toString()))
  },
  totalAmountBase: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0,
    get: v => (v == null ? 0 : parseFloat(v.toString()))
  },
  // Public action tokens
  publicAcceptToken: { type: String, default: null },
  publicRejectToken: { type: String, default: null },
  publicTokenExpiresAt: { type: Date, default: null },
  // Capture customer acceptance/rejection metadata
  customerAction: {
    action: { type: String, enum: ['accepted', 'rejected', null], default: null },
    name: { type: String, default: null },
    email: { type: String, default: null },
    comment: { type: String, default: null },
    ip: { type: String, default: null },
    actedAt: { type: Date, default: null }
  },
  lastGeneratedPdfUrl: { type: String, default: null },
  // Terms and conditions
  terms: {
    type: String,
    default: null
  },
  // Additional notes
  notes: {
    type: String,
    default: null
  },
  // Store company and client TINs for PDF/printing convenience
  companyTin: String,
  clientTin: String,
  // Created by user
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Created by user is required']
  },
  // Approved by user
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  // Approval date
  approvedDate: Date,
  // Converted to invoice reference
  convertedToInvoice: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice'
  },
  // Converted to sales order reference (NEW WORKFLOW)
  convertedToSalesOrder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SalesOrder'
  },
  // Conversion date
  conversionDate: Date
}, {
  timestamps: true
});

// Compound index for company + unique reference number
quotationSchema.index({ company: 1, referenceNo: 1 }, { unique: true });
quotationSchema.index({ company: 1 });
quotationSchema.index({ company: 1, status: 1 });
quotationSchema.index({ client: 1 });
quotationSchema.index({ expiryDate: 1, company: 1 });

// Auto-generate reference number
quotationSchema.pre('save', async function(next) {
  if (this.isNew && !this.referenceNo) {
    this.referenceNo = await generateUniqueNumber('QUO', mongoose.model('Quotation'), this.company, 'referenceNo');
  }
  next();
});

// Calculate line totals and grand totals before saving
quotationSchema.pre('save', function(next) {
  if (this.lines && this.lines.length > 0) {
    let subtotal = 0;
    let totalDiscount = 0;
    let totalTax = 0;
    
    this.lines.forEach(line => {
      const qty = parseFloat(line.qty?.toString() || '0');
      const unitPrice = parseFloat(line.unitPrice?.toString() || '0');
      const discountPct = parseFloat(line.discountPct?.toString() || '0');
      const taxRate = parseFloat(line.taxRate?.toString() || '0');
      
      // Line subtotal: qty × unitPrice
      const lineSubtotal = qty * unitPrice;
      
      // Line discount amount
      const lineDiscount = lineSubtotal * (discountPct / 100);
      
      // Line total after discount
      const lineTotalAfterDiscount = lineSubtotal - lineDiscount;
      
      // Line tax
      const lineTax = lineTotalAfterDiscount * (taxRate / 100);
      
      // Line total (including discount, before tax)
      line.lineTotal = lineTotalAfterDiscount;
      line.lineTax = lineTax;
      
      // Accumulate totals
      subtotal += lineSubtotal;
      totalDiscount += lineDiscount;
      totalTax += lineTax;
    });
    
    this.subtotal = subtotal;
    this.totalDiscount = totalDiscount;
    this.taxAmount = totalTax;
    this.totalAmount = subtotal - totalDiscount + totalTax;
  } else {
    this.subtotal = 0;
    this.totalDiscount = 0;
    this.taxAmount = 0;
    this.totalAmount = 0;
  }
  next();
});

// Serialize Decimal128 fields as strings for API
quotationSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    const toQty = (v) => {
      if (v == null) return '0.0000';
      const num = typeof v === 'number' ? v : parseFloat(v.toString());
      return isFinite(num) ? num.toFixed(4) : '0.0000';
    };
    const toMoney = (v) => {
      if (v == null) return '0.000000';
      const num = typeof v === 'number' ? v : parseFloat(v.toString());
      return isFinite(num) ? num.toFixed(6) : '0.000000';
    };
    const toAmount = (v) => {
      if (v == null) return '0.00';
      const num = typeof v === 'number' ? v : parseFloat(v.toString());
      return isFinite(num) ? num.toFixed(2) : '0.00';
    };
    
    // Serialize line items
    if (ret.lines) {
      ret.lines = ret.lines.map(line => ({
        ...line,
        qty: toQty(line.qty),
        unitPrice: toMoney(line.unitPrice),
        discountPct: line.discountPct != null ? parseFloat(line.discountPct.toString()).toFixed(4) : '0.0000',
        taxRate: line.taxRate != null ? parseFloat(line.taxRate.toString()).toFixed(4) : '0.0000',
        lineTotal: toAmount(line.lineTotal),
        lineTax: toAmount(line.lineTax)
      }));
    }
    
    // Serialize header fields
    if (ret.subtotal !== undefined) ret.subtotal = toAmount(ret.subtotal);
    if (ret.totalDiscount !== undefined) ret.totalDiscount = toAmount(ret.totalDiscount);
    if (ret.taxAmount !== undefined) ret.taxAmount = toAmount(ret.taxAmount);
    if (ret.totalAmount !== undefined) ret.totalAmount = toAmount(ret.totalAmount);
    if (ret.exchangeRate !== undefined) ret.exchangeRate = toMoney(ret.exchangeRate);
    
    // Rename fields for API response
    ret.referenceNo = ret.referenceNo;
    ret.expiryDate = ret.expiryDate;
    
    return ret;
  }
});

quotationSchema.set('toObject', { virtuals: true });

// Apply audit plugin
const auditPlugin = require('./plugins/auditSoftDeletePlugin');
quotationSchema.plugin(auditPlugin);

// Apply decimal transform plugin
quotationSchema.plugin(decimalTransform);

module.exports = mongoose.model('Quotation', quotationSchema);
