const mongoose = require('mongoose');

const EBM_SEQUENCE_TYPES = Object.freeze({
  SALES_INVOICE: 'sales_invoice',
  RECEIPT: 'receipt',
  REPORT: 'report',
  STOCK_SAR: 'stock_sar',
});

const ebmSequenceSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  branchId: {
    type: String,
    required: true,
    trim: true,
    minlength: 2,
    maxlength: 2,
  },
  sequenceType: {
    type: String,
    required: true,
    enum: Object.values(EBM_SEQUENCE_TYPES),
  },
  lastNumber: {
    type: Number,
    required: true,
    default: 0,
    min: 0,
  },
  seededFrom: {
    type: String,
    default: null,
    trim: true,
  },
  seededAt: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
});

ebmSequenceSchema.index(
  { company: 1, branchId: 1, sequenceType: 1 },
  { unique: true },
);

module.exports = mongoose.model('EBMSequence', ebmSequenceSchema);
module.exports.EBM_SEQUENCE_TYPES = EBM_SEQUENCE_TYPES;
