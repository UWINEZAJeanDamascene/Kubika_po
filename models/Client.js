const mongoose = require('mongoose');
const { generateUniqueCode } = require('./utils/autoIncrement');

const clientSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Client must belong to a company']
  },
  name: {
    type: String,
    required: [true, 'Please provide a client name'],
    trim: true
  },
  code: {
    type: String,
    uppercase: true,
    trim: true
  },
  type: {
    type: String,
    enum: ['individual', 'company'],
    default: 'individual'
  },
  contact: {
    phone: String,
    email: {
      type: String,
      lowercase: true,
      trim: true
    },
    fax: String,
    website: String,
    address: String,
    city: String,
    state: String,
    zipCode: String,
    country: String,
    contactPerson: String
  },
  salesArea: String,
  salesRepId: String,
  region: String,
  industry: String,
  registrationDate: Date,
  taxId: String,
  ebmTinVerification: { type: mongoose.Schema.Types.Mixed, default: null },
  paymentTerms: {
    type: String,
    enum: ['cash', 'credit_7', 'credit_15', 'credit_30', 'credit_45', 'credit_60'],
    default: 'cash'
  },
  creditLimit: {
    type: Number,
    default: 0
  },
  outstandingBalance: {
    type: Number,
    default: 0
  },
  totalPurchases: {
    type: Number,
    default: 0
  },
  lastPurchaseDate: Date,
  notes: String,
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  customFields: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  ebmBranchCustomers: [{
    branchId: { type: String, trim: true, maxlength: 2 },
    status: {
      type: String,
      enum: ['not_registered', 'registered', 'failed'],
      default: 'not_registered'
    },
    submittedAt: Date,
    error: String
  }]
}, {
  timestamps: true
});

// Compound index for company + unique code
clientSchema.index({ company: 1, code: 1 }, { unique: true });
clientSchema.index({ company: 1 });

// Auto-generate client code
clientSchema.pre('save', async function(next) {
  if (this.isNew) {
    if (!this.code) {
      // Auto-generate unique code if not provided
      this.code = await generateUniqueCode('CLI', mongoose.model('Client'), this.company, 'code');
    } else {
      // Check if provided code already exists for this company
      const existingClient = await mongoose.model('Client').findOne({
        company: this.company,
        code: this.code.toUpperCase()
      });
      
      if (existingClient) {
        // Auto-generate a new unique code instead of throwing error
        this.code = await generateUniqueCode('CLI', mongoose.model('Client'), this.company, 'code');
      }
    }
  }
  next();
});

module.exports = mongoose.model('Client', clientSchema);

