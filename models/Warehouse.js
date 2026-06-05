const mongoose = require('mongoose');
const { generateUniqueCode, generateShortSequentialCode } = require('./utils/autoIncrement');

const warehouseSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Warehouse must belong to a company']
  },
  name: {
    type: String,
    required: [true, 'Please provide a warehouse name'],
    trim: true
  },
  code: {
    type: String,
    uppercase: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  location: {
    address: String,
    city: String,
    country: String,
    contactPerson: String,
    phone: String,
    email: String
  },
  // Optional warehouse-specific inventory account (account code)
  inventoryAccount: {
    type: String,
    default: null
  },
  isActive: {
    type: Boolean,
    default: true
  },
  isDefault: {
    type: Boolean,
    default: false
  },
  // Track total stock value and quantity in this warehouse
  totalProducts: {
    type: Number,
    default: 0
  },
  totalValue: {
    type: Number,
    default: 0
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  customFields: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  rraBranchId: {
    type: String,
    trim: true,
    minlength: 2,
    maxlength: 2,
    immutable: true,
    default: null
  },
  ebmRegistrationStatus: {
    type: String,
    enum: ['not_registered', 'registered', 'failed'],
    default: 'not_registered',
    index: true
  },
  ebmRegisteredAt: {
    type: Date,
    default: null
  },
  ebmLastAttemptAt: {
    type: Date,
    default: null
  },
  ebmRegistrationError: {
    type: String,
    trim: true,
    default: null
  },
  ebmUsersSubmitted: {
    type: Boolean,
    default: false
  },
  ebmInsurances: [{
    isrccCd: { type: String, trim: true },
    isrccNm: { type: String, trim: true },
    isrcRt: { type: Number, default: 0 },
    useYn: { type: String, enum: ['Y', 'N'], default: 'Y' }
  }],
  ebmInsuranceSubmitted: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Compound index for company + unique code
warehouseSchema.index({ company: 1, code: 1 }, { unique: true });
warehouseSchema.index({ company: 1 });
warehouseSchema.index({ company: 1, rraBranchId: 1 }, { unique: true, partialFilterExpression: { rraBranchId: { $type: 'string' } } });
// Partial unique index to ensure only one default warehouse per company
warehouseSchema.index(
  { company: 1, isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } }
);

// Auto-generate warehouse code
warehouseSchema.pre('save', async function(next) {
  if (this.isNew) {
      if (!this.code) {
      // Auto-generate short sequential warehouse code if not provided (e.g., WH001)
      this.code = await generateShortSequentialCode('WH', mongoose.model('Warehouse'), this.company, 'code', 3);
    } else {
      // Check if provided code already exists for this company
      const existingWarehouse = await mongoose.model('Warehouse').findOne({
        company: this.company,
        code: this.code.toUpperCase()
      });
      
      if (existingWarehouse) {
        // Auto-generate a new short sequential code instead of throwing error
        this.code = await generateShortSequentialCode('WH', mongoose.model('Warehouse'), this.company, 'code', 3);
      }
    }
    
    // If this is the first warehouse, make it default
    const count = await mongoose.model('Warehouse').countDocuments({ company: this.company });
    if (count === 0) {
      this.isDefault = true;
    }
  }
  next();
});

warehouseSchema.pre('save', async function(next) {
  try {
    if (!this.isNew || this.rraBranchId) return next();
    if (this.isDefault) {
      this.rraBranchId = '00';
      return next();
    }
    const Sequence = require('./Sequence');
    const seq = await Sequence.findOneAndUpdate(
      { company: this.company, name: 'rra_branch_id', year: 0 },
      { $inc: { seq: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    this.rraBranchId = String(seq.seq).padStart(2, '0');
    next();
  } catch (err) {
    next(err);
  }
});

// Prevent setting more than one default warehouse
warehouseSchema.pre('save', async function(next) {
  if (this.isDefault && this.isModified('isDefault')) {
    await mongoose.model('Warehouse').updateMany(
      { company: this.company, _id: { $ne: this._id } },
      { isDefault: false }
    );
  }
  next();
});

module.exports = mongoose.model('Warehouse', warehouseSchema);
