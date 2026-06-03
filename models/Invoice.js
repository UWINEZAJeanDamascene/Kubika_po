const mongoose = require('mongoose');
const { generateUniqueNumber } = require('./utils/autoIncrement');
const ebmSubmissionSchema = require('./schemas/ebmSubmissionSchema');

// Invoice line item schema - matches Module 6 sales_invoice_lines table
const invoiceLineSchema = new mongoose.Schema({
  // Line reference
  lineId: {
    type: mongoose.Schema.Types.ObjectId,
    default: () => new mongoose.Types.ObjectId()
  },
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  productName: String,
  productCode: String,
  description: String,
  
  // Quantities and pricing - Module 6 naming
  qty: {
    type: Number,
    required: true,
    min: 0.0001,
    alias: 'quantity'
  },
  unit: String,
  unitPrice: {
    type: Number,
    required: true,
    min: 0
  },
  discountPct: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
    alias: 'discount'
  },
  taxRate: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  taxCode: {
    type: String,
    enum: ['A', 'B', 'None'],
    default: 'A'
  },
  
  // Line totals - Module 6 naming
  lineSubtotal: {
    type: Number,
    default: 0,
    alias: 'subtotal'
  },
  lineTax: {
    type: Number,
    default: 0,
    alias: 'taxAmount'
  },
  lineTotal: {
    type: Number,
    default: 0,
    alias: 'totalWithTax'
  },
  
  // COGS fields - populated at confirmation time
  unitCost: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0
  },
  cogsAmount: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0
  },
  
  // Warehouse for stock reservation
  warehouse: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Warehouse'
  },
  
  // Track quantity credited (for Module 8 Credit Notes)
  qtyCredited: {
    type: Number,
    default: 0
  }
},
{
toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtual for backwards compatibility
invoiceLineSchema.virtual('quantity').get(function() {
  return this.qty;
});
invoiceLineSchema.virtual('itemCode').get(function() {
  return this.productCode;
});

// Payment schema
const paymentSchema = new mongoose.Schema({
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  paymentMethod: {
    type: String,
    enum: ['cash', 'card', 'bank_transfer', 'cheque', 'mobile_money'],
    required: true
  },
  reference: String,
  paidDate: {
    type: Date,
    default: Date.now
  },
  notes: String,
  recordedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
});

// Main invoice schema - Module 6 enhanced
const invoiceSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Invoice must belong to a company']
  },
  
  // Reference number - Module 6 naming (INV-YYYY-NNNNN)
  referenceNo: {
    type: String,
    uppercase: true,
    alias: 'invoiceNumber'
  },
  
  // Client reference - Module 6 naming
  client: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true
  },
  
  // Customer details captured at invoice time
  customerTin: String,
  customerName: String,
  customerAddress: String,
  
  // Quotation reference - Module 6 naming
  quotation: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Quotation',
    alias: 'quotation_id'
  },
  
  // Sales Order reference (new workflow)
  salesOrder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SalesOrder',
    default: null
  },
  
  // Delivery Note reference (new workflow)
  deliveryNote: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DeliveryNote',
    default: null
  },
  
  // Invoice status - Module 6 enum values
  status: {
    type: String,
    enum: ['draft', 'confirmed', 'partially_paid', 'fully_paid', 'cancelled'],
    default: 'draft'
  },
  
  // Currency and exchange rate - Module 6 fields
  currencyCode: {
    type: String,
    default: 'RWF',
    alias: 'currency'
  },
  exchangeRate: {
    type: mongoose.Schema.Types.Decimal128,
    default: 1
  },
  
  // Invoice lines - Module 6 naming (items → lines)
  lines: {
    type: [invoiceLineSchema],
    alias: 'items',
    default: []
  },
  
  // Tax breakdown - Module 6 naming
  taxAmount: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0,
    alias: 'totalTax'
  },
  
  // Financial totals - Module 6 naming
  subtotal: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0
  },
  totalAmount: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0,
    alias: 'grandTotal'
  },
  
  // Legacy totals (for compatibility)
  totalAEx: {
    type: Number,
    default: 0
  },
  totalB18: {
    type: Number,
    default: 0
  },
  totalTaxA: {
    type: Number,
    default: 0
  },
  totalTaxB: {
    type: Number,
    default: 0
  },
  totalDiscount: {
    type: Number,
    default: 0
  },
  roundedAmount: {
    type: Number,
    default: 0
  },
  discount: {
    type: Number,
    default: 0
  },
  total: {
    type: Number,
    default: 0
  },
  
  // Payment tracking - Module 6 naming
  amountPaid: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0
  },
  amountOutstanding: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0,
    alias: 'balance'
  },
  payments: [paymentSchema],
  
  // Dates - Module 6 naming
  invoiceDate: {
    type: Date,
    default: Date.now,
    alias: 'date'
  },
  dueDate: {
    type: Date,
    required: true
  },
  terms: String,
  notes: String,
  
  // Journal entry references - Module 6 fields
  revenueJournalEntry: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'JournalEntry',
    alias: 'revenue_journal_entry_id'
  },
  cogsJournalEntry: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'JournalEntry',
    alias: 'cogs_journal_entry_id'
  },
  
  // Stock tracking
  stockDeducted: {
    type: Boolean,
    default: false
  },
  stockReserved: {
    type: Boolean,
    default: false
  },
  
  // User tracking - Module 6 naming
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
    default: null
  },
  paidDate: Date,
  confirmedDate: {
    type: Date,
    alias: 'confirmed_at'
  },
  confirmedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    alias: 'confirmed_by'
  },
  cancelledDate: Date,
  cancelledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  cancellationReason: String,
  
  // Bad debt tracking
  badDebtWrittenOff: {
    type: Boolean,
    default: false
  },
  writtenOffAt: Date,
  writtenOffBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  badDebtReason: String,
  badDebtNotes: String,
  reversedFromBadDebt: {
    type: Boolean,
    default: false
  },
  reverseBadDebtReason: String,
  reverseBadDebtAt: Date,
  
  // Link to recurring template if generated automatically
  generatedFromRecurring: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RecurringInvoice'
  },
  // Auto-confirm flag - when true, invoice is auto-confirmed on creation
  autoConfirm: {
    type: Boolean,
    default: false
  },
  // Credit notes applied to this invoice
  creditNotes: [{
    creditNoteId: { type: mongoose.Schema.Types.ObjectId, ref: 'CreditNote' },
    creditNoteNumber: String,
    amount: { type: Number, default: 0 },
    appliedDate: { type: Date, default: Date.now }
  }],

  ebm: {
    type: ebmSubmissionSchema,
    default: () => ({}),
  }
}, {
  timestamps: true,
  toJSON: { 
    virtuals: true,
    transform: function(doc, ret) {
      // Convert Decimal128 to Number for JSON
      if (ret.subtotal) ret.subtotal = parseFloat(ret.subtotal);
      if (ret.taxAmount) ret.taxAmount = parseFloat(ret.taxAmount);
      if (ret.totalAmount) ret.totalAmount = parseFloat(ret.totalAmount);
      if (ret.amountPaid) ret.amountPaid = parseFloat(ret.amountPaid);
      if (ret.amountOutstanding) ret.amountOutstanding = parseFloat(ret.amountOutstanding);
      if (ret.exchangeRate) ret.exchangeRate = parseFloat(ret.exchangeRate);
      
      // Convert line Decimal128 fields
      if (ret.lines) {
        ret.lines = ret.lines.map(line => {
          if (line.unitCost) line.unitCost = parseFloat(line.unitCost);
          if (line.cogsAmount) line.cogsAmount = parseFloat(line.cogsAmount);
          return line;
        });
      }
      
      // Backwards compatibility aliases
      ret.invoiceNumber = ret.referenceNo || ret.invoiceNumber;
      ret.grandTotal = ret.totalAmount ? parseFloat(ret.totalAmount) : ret.grandTotal;
      ret.balance = ret.amountOutstanding ? parseFloat(ret.amountOutstanding) : ret.balance;
      ret.currency = ret.currencyCode || ret.currency;
      ret.items = ret.lines || ret.items;
      ret.date = ret.invoiceDate || ret.date;
      
      return ret;
    }
  },
  toObject: { 
    virtuals: true,
    transform: function(doc, ret) {
      // Convert Decimal128 to Number
      if (ret.subtotal) ret.subtotal = parseFloat(ret.subtotal);
      if (ret.taxAmount) ret.taxAmount = parseFloat(ret.taxAmount);
      if (ret.totalAmount) ret.totalAmount = parseFloat(ret.totalAmount);
      if (ret.amountPaid) ret.amountPaid = parseFloat(ret.amountPaid);
      if (ret.amountOutstanding) ret.amountOutstanding = parseFloat(ret.amountOutstanding);
      if (ret.exchangeRate) ret.exchangeRate = parseFloat(ret.exchangeRate);
      
      // Convert line Decimal128 fields
      if (ret.lines) {
        ret.lines = ret.lines.map(line => {
          if (line.unitCost) line.unitCost = parseFloat(line.unitCost);
          if (line.cogsAmount) line.cogsAmount = parseFloat(line.cogsAmount);
          return line;
        });
      }
      
      // Backwards compatibility aliases
      ret.invoiceNumber = ret.referenceNo || ret.invoiceNumber;
      ret.grandTotal = ret.totalAmount ? parseFloat(ret.totalAmount) : ret.grandTotal;
      ret.balance = ret.amountOutstanding ? parseFloat(ret.amountOutstanding) : ret.balance;
      ret.currency = ret.currencyCode || ret.currency;
      ret.items = ret.lines || ret.items;
      ret.date = ret.invoiceDate || ret.date;
      
      return ret;
    }
  }
});

// Compound index for company + unique invoice number
invoiceSchema.index({ company: 1, referenceNo: 1 }, { unique: true });

// Performance indexes for reports
invoiceSchema.index({ company: 1, status: 1 });
invoiceSchema.index({ company: 1, status: 1, dueDate: 1 });
invoiceSchema.index({ company: 1, paidDate: 1 });
invoiceSchema.index({ company: 1, invoiceDate: 1 });
invoiceSchema.index({ company: 1, client: 1, status: 1 });
invoiceSchema.index({ company: 1, 'ebm.ebmStatus': 1 });
invoiceSchema.index({ 'payments.paidDate': 1 });
invoiceSchema.index({ client: 1 });
invoiceSchema.index({ createdBy: 1 });
invoiceSchema.index({ quotation: 1 });

invoiceSchema.pre('validate', function(next) {
  if (this.dueDate && this.invoiceDate) {
    const due = this.dueDate instanceof Date ? this.dueDate : new Date(this.dueDate);
    const inv = this.invoiceDate instanceof Date ? this.invoiceDate : new Date(this.invoiceDate);
    if (due.getTime() < inv.getTime()) {
      this.invalidate('dueDate', 'Due date must be on or after invoice date');
    }
  }
  next();
});

// Auto-generate invoice number - Module 6 format INV-YYYY-NNNNN
invoiceSchema.pre('save', async function(next) {
  if (this.isNew && !this.referenceNo) {
    this.referenceNo = await generateUniqueNumber('INV', mongoose.model('Invoice'), this.company, 'referenceNo');
  }
  next();
});

// Calculate totals before saving - Module 6 logic
invoiceSchema.pre('save', function(next) {
  const lines = this.lines || this.items || [];
  
  if (lines.length > 0) {
    // Calculate tax breakdown
    let totalAEx = 0;
    let totalB18 = 0;
    let totalTaxA = 0;
    let totalTaxB = 0;
    let subtotalVal = 0;
    let totalDiscount = 0;
    
    lines.forEach(line => {
      const qty = line.qty || line.quantity || 0;
      const unitPrice = line.unitPrice || 0;
      const discountPct = line.discountPct || line.discount || 0;
      const taxRate = line.taxRate || 0;
      
      const lineSubtotal = qty * unitPrice;
      const lineDiscount = lineSubtotal * (discountPct / 100);
      const netAmount = lineSubtotal - lineDiscount;
      const lineTax = netAmount * (taxRate / 100);
      const lineTotal = netAmount + lineTax;
      
      // Update line calculations - Module 6 naming
      line.lineSubtotal = lineSubtotal;
      line.lineTax = lineTax;
      line.lineTotal = lineTotal;
      line.subtotal = lineSubtotal; // backwards compat
      line.taxAmount = lineTax; // backwards compat
      line.totalWithTax = lineTotal; // backwards compat
      
      subtotalVal += lineSubtotal;
      totalDiscount += lineDiscount;
      
      if (line.taxCode === 'A') {
        totalAEx += netAmount;
        totalTaxA += lineTax;
      } else if (line.taxCode === 'B') {
        totalB18 += netAmount;
        totalTaxB += lineTax;
      }
    });
    
    // Set tax breakdown
    this.totalAEx = totalAEx;
    this.totalB18 = totalB18;
    this.totalTaxA = totalTaxA;
    this.totalTaxB = totalTaxB;
    
    // Calculate totals - Module 6 naming with Decimal128
    const totalTaxVal = totalTaxA + totalTaxB;
    const grandTotalVal = subtotalVal - totalDiscount + totalTaxVal;
    
    this.subtotal = mongoose.Types.Decimal128.fromString(subtotalVal.toFixed(2));
    this.taxAmount = mongoose.Types.Decimal128.fromString(totalTaxVal.toString());
    this.totalAmount = mongoose.Types.Decimal128.fromString(grandTotalVal.toString());
    this.totalTax = totalTaxVal; // backwards compat
    
    // Legacy calculations
    this.subtotal = subtotalVal;
    this.totalDiscount = totalDiscount;
    this.totalTax = totalTaxVal;
    this.grandTotal = grandTotalVal;
    this.roundedAmount = Math.round(grandTotalVal * 100) / 100;
    this.taxAmount = totalTaxVal;
    this.discount = totalDiscount;
    this.total = this.roundedAmount || grandTotalVal;
    
    // Amount outstanding calculation - Module 6
    const amountPaidVal = parseFloat(this.amountPaid) || 0;
    this.amountOutstanding = mongoose.Types.Decimal128.fromString((grandTotalVal - amountPaidVal).toFixed(2));
    this.balance = (grandTotalVal - amountPaidVal); // backwards compat
  }
  
  // Update status based on payment - Module 6 naming
  // Only auto-confirm if autoConfirm is explicitly true
  const amountPaidVal = parseFloat(this.amountPaid) || 0;
  const grandTotalVal = this.roundedAmount || parseFloat(this.totalAmount) || 0;
  
  if (grandTotalVal > 0 && amountPaidVal >= grandTotalVal) {
    this.status = 'fully_paid';
    if (!this.paidDate) {
      this.paidDate = new Date();
    }
  } else if (amountPaidVal > 0 && amountPaidVal < grandTotalVal) {
    this.status = 'partially_paid';
  } else if (this.status === 'cancelled') {
    // Keep cancelled status
  } else if (amountPaidVal === 0 && grandTotalVal > 0 && this.autoConfirm === true) {
    // Only auto-confirm if autoConfirm flag is explicitly true
    this.status = 'confirmed';
  }
  // Otherwise keep the existing status (default is 'draft')
  
  next();
});

// Ensure Decimal128 money fields expose fixed 2-decimal string when accessed
if (invoiceSchema.path('amountPaid')) {
  invoiceSchema.path('amountPaid').get(function(v) {
    if (v == null) return '0.00';
    try { return parseFloat(v.toString()).toFixed(2); } catch (e) { return String(v); }
  });
}

if (invoiceSchema.path('amountOutstanding')) {
  invoiceSchema.path('amountOutstanding').get(function(v) {
    if (v == null) return '0.00';
    try { return parseFloat(v.toString()).toFixed(2); } catch (e) { return String(v); }
  });
}

// Virtual for backwards compatibility
invoiceSchema.virtual('invoiceNumber').get(function() {
  return this.referenceNo;
});
invoiceSchema.virtual('items').get(function() {
  return this.lines;
});
invoiceSchema.virtual('grandTotal').get(function() {
  const val = this.totalAmount || this._doc && this._doc.total;
  return parseFloat(val) || (this._doc && this._doc.grandTotal) || 0;
});

invoiceSchema.virtual('balance').get(function() {
  // Avoid referencing the virtual itself (this.balance) which causes recursion.
  if (this.amountOutstanding !== undefined && this.amountOutstanding !== null) {
    return parseFloat(this.amountOutstanding) || 0;
  }
  if (this._doc && this._doc.balance !== undefined) {
    return parseFloat(this._doc.balance) || 0;
  }
  return 0;
});
invoiceSchema.virtual('currency').get(function() {
  return this.currencyCode || 'RWF';
});

// Post-save hook for AR tracking
invoiceSchema.post('save', async function(doc) {
  try {
    // Track invoice creation (when status changes to confirmed from draft)
    if (this._previousStatus === 'draft' && doc.status === 'confirmed') {
      const ARTrackingService = require('../services/arTrackingService');
      await ARTrackingService.recordInvoiceCreated(doc, doc.confirmedBy || doc.createdBy);
    }
    
    // Track invoice cancellation
    if (this._previousStatus !== 'cancelled' && doc.status === 'cancelled') {
      const ARTrackingService = require('../services/arTrackingService');
      await ARTrackingService.recordInvoiceCancelled(doc, doc.cancelledBy || doc.createdBy, doc.cancellationReason);
    }
  } catch (error) {
    // Don't fail the save if tracking fails
    console.error('AR tracking error in invoice post-save:', error);
  }
});

// Pre-save hook to capture previous status
invoiceSchema.pre('save', function(next) {
  if (this.isModified('status') && !this.isNew) {
    // Store previous status for post-save hook
    this.constructor.findById(this._id).select('status').then(prev => {
      if (prev) {
        this._previousStatus = prev.status;
      }
      next();
    }).catch(err => {
      console.error('Error getting previous invoice status:', err);
      next();
    });
  } else {
    next();
  }
});

module.exports = mongoose.model('Invoice', invoiceSchema);
