/**
 * Module 5 - Fixed Assets Model
 * 
 * Fixed assets are long-lived items (equipment, vehicles, computers) that are
 * capitalised rather than expensed immediately. They depreciate over their useful life.
 */

const mongoose = require('mongoose');
const { nextSequence } = require('../services/sequenceService');

const fixedAssetSchema = new mongoose.Schema({
  // Company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },

  // Reference number (AST-NNNNN per Module 5 spec) - auto-generated in pre-save
  referenceNo: {
    type: String
  },

  // Asset details
  name: {
    type: String,
    required: true,
    maxlength: 200
  },
  description: {
    type: String,
    default: null
  },

  // Category reference (for reporting and defaults - separate from account codes)
  categoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AssetCategory',
    default: null
  },

  // Account references (1500-series for asset accounts)
  assetAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChartOfAccount',
    default: null
  },
  assetAccountCode: {
    type: String,
    required: true
  },

  // Accumulated depreciation account (1510-series)
  accumDepreciationAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChartOfAccount',
    default: null
  },
  accumDepreciationAccountCode: {
    type: String,
    required: true
  },

  // Depreciation expense account (6xxx)
  depreciationExpenseAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChartOfAccount',
    default: null
  },
  depreciationExpenseAccountCode: {
    type: String,
    required: true
  },

  // Purchase details
  purchaseDate: {
    type: Date,
    required: true
  },
  purchaseCost: {
    type: mongoose.Schema.Types.Decimal128,
    required: true
  },
  salvageValue: {
    type: mongoose.Schema.Types.Decimal128,
    default: mongoose.Types.Decimal128.fromString('0')
  },

  // Depreciation settings
  usefulLifeMonths: {
    type: Number,
    required: true,
    min: 1
  },
  depreciationMethod: {
    type: String,
    enum: ['straight_line', 'declining_balance'],
    required: true,
    default: 'straight_line'
  },
  decliningRate: {
    type: mongoose.Schema.Types.Decimal128,
    default: null // Required if method = declining_balance
  },

  // Status tracking - Full asset lifecycle
  status: {
    type: String,
    enum: [
      'in_transit',        // Ordered but not yet received
      'in_service',        // Active, depreciating (replaces 'active')
      'under_maintenance', // Temporarily out of service
      'idle',              // Not in use but still owned
      'fully_depreciated', // Book value = salvage value
      'disposed'           // Sold, scrapped, or retired
    ],
    default: 'in_transit'  // Start as in_transit until received
  },

  // When asset was actually put into service (depreciation start date)
  inServiceDate: {
    type: Date,
    default: null  // If null, defaults to purchaseDate
  },

  // For RRA compliance - when asset first used for income generation
  rraInServiceDate: {
    type: Date,
    default: null
  },

  // Track if asset is ready for use but not yet in service
  isReadyForService: {
    type: Boolean,
    default: false
  },

  // Disposal details
  disposalDate: {
    type: Date,
    default: null
  },
  disposalProceeds: {
    type: mongoose.Schema.Types.Decimal128,
    default: null
  },
  disposalCosts: {
    type: mongoose.Schema.Types.Decimal128,
    default: null  // Removal, transport, legal fees
  },
  disposalNetProceeds: {
    type: mongoose.Schema.Types.Decimal128,
    default: null  // Proceeds - costs
  },
  disposalGainLoss: {
    type: mongoose.Schema.Types.Decimal128,
    default: null  // Calculated gain or loss
  },
  disposalMethod: {
    type: String,
    enum: ['sale', 'scrap', 'donation', 'trade_in', 'theft_loss', 'transfer', null],
    default: null
  },
  disposalNotes: {
    type: String,
    maxlength: 1000,
    default: null
  },
  disposalAuthNumber: {
    type: String,
    default: null  // RRA disposal authorization
  },
  disposalCustomerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    default: null  // If sold to customer
  },
  disposalEventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AssetDisposalEvent',
    default: null
  },
  disposalJournalEntryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'JournalEntry',
    default: null
  },

  // Computed/calculated fields
  accumulatedDepreciation: {
    type: mongoose.Schema.Types.Decimal128,
    default: mongoose.Types.Decimal128.fromString('0')
  },
  netBookValue: {
    type: mongoose.Schema.Types.Decimal128,
    default: mongoose.Types.Decimal128.fromString('0')
  },

  // Links
  supplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    default: null
  },

  // Physical tracking
  serialNumber: {
    type: String,
    default: null
  },
  location: {
    type: String,
    default: null
  },
  departmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    default: null
  },

  // Warranty information
  warrantyStartDate: {
    type: Date,
    default: null
  },
  warrantyEndDate: {
    type: Date,
    default: null
  },

  // Insurance details
  insuredValue: {
    type: mongoose.Schema.Types.Decimal128,
    default: null
  },

  // Attachments (file references)
  attachments: [{
    fileName: String,
    fileUrl: String,
    fileType: String,
    uploadedAt: {
      type: Date,
      default: Date.now
    }
  }],

  // Depreciation settings
  depreciationFrequency: {
    type: String,
    enum: ['monthly', 'quarterly', 'semi_annually', 'annually'],
    default: 'monthly'
  },

  // Track when depreciation was last posted for this frequency
  lastDepreciationPeriod: {
    type: String,  // Format: YYYY-MM or YYYY-Q# or YYYY
    default: null
  },

  // Depreciation calculated flag
  lastDepreciationDate: {
    type: Date,
    default: null
  },

  // Acquisition method tracking
  acquisitionMethod: {
    type: String,
    enum: [
      'purchase',            // Bought outright
      'finance_lease',       // Capital lease (IFRS 16)
      'operating_lease',     // Short-term lease
      'donation',            // Gift - record at fair value
      'construction',        // Self-built, capitalize costs
      'transfer_in',         // From another entity
      'business_combination' // Acquisition
    ],
    default: 'purchase'
  },

  // For donated assets
  donationFairValue: {
    type: mongoose.Schema.Types.Decimal128,
    default: null
  },

  // For construction assets
  constructionCompletionDate: {
    type: Date,
    default: null
  },

  // Physical tracking - custodian
  custodianId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },

  // Soft delete
  isDeleted: {
    type: Boolean,
    default: false
  },
  deletedAt: {
    type: Date,
    default: null
  },

  // Tracking
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Indexes
fixedAssetSchema.index({ company: 1, status: 1 });
// Make referenceNo unique per company (avoid global collisions across test DBs)
fixedAssetSchema.index({ company: 1, referenceNo: 1 }, { unique: true });

// Pre-save hook to generate reference number and calculate net book value
fixedAssetSchema.pre('save', async function(next) {
  // Generate reference number if not provided
  if (!this.referenceNo) {
    try {
      const seq = await nextSequence(this.company, 'fixed_asset');
      const year = new Date().getFullYear();
      this.referenceNo = `AST-${year}-${seq}`;
    } catch (e) {
      // Fallback to timestamp-based ref if sequence service fails
      const ts = Date.now();
      this.referenceNo = `AST-${new Date().getFullYear()}-${String(ts).slice(-5)}`;
    }
  }

  // Calculate net book value - NBV should never go below salvage value
  // BUT: Don't recalculate for disposed assets - NBV should remain 0 after disposal
  if (this.status === 'disposed') {
    // For disposed assets, keep NBV at 0 (set explicitly in disposal controller)
    this.netBookValue = mongoose.Types.Decimal128.fromString('0');
  } else if (this.purchaseCost && this.accumulatedDepreciation) {
    const purchaseCost = typeof this.purchaseCost === 'object' 
      ? parseFloat(this.purchaseCost.toString()) 
      : this.purchaseCost;
    const accumDep = typeof this.accumulatedDepreciation === 'object' 
      ? parseFloat(this.accumulatedDepreciation.toString()) 
      : this.accumulatedDepreciation;
    const salvage = typeof this.salvageValue === 'object' 
      ? parseFloat(this.salvageValue.toString()) 
      : this.salvageValue;
    
    // NBV = max(salvage_value, purchase_cost - accumulated_depreciation)
    const nbv = Math.max(salvage, purchaseCost - accumDep);
    this.netBookValue = mongoose.Types.Decimal128.fromString(nbv.toString());
  }

  // Update status based on accumulated depreciation - NBV has reached salvage value
  if (this.purchaseCost && this.accumulatedDepreciation && this.usefulLifeMonths) {
    const purchaseCost = typeof this.purchaseCost === 'object' 
      ? parseFloat(this.purchaseCost.toString()) 
      : this.purchaseCost;
    const accumDep = typeof this.accumulatedDepreciation === 'object' 
      ? parseFloat(this.accumulatedDepreciation.toString()) 
      : this.accumulatedDepreciation;
    
    // Check if fully depreciated (accumulated >= depreciable amount = purchase_cost - salvage)
    const salvageVal = typeof this.salvageValue === 'object' 
      ? parseFloat(this.salvageValue.toString()) 
      : this.salvageValue;
    const depreciableAmount = purchaseCost - salvageVal;
    if (accumDep >= depreciableAmount) {
      this.status = 'fully_depreciated';
    } else if (this.status === 'fully_depreciated' && accumDep < depreciableAmount) {
      // Restore to in_service if depreciation was reversed
      this.status = 'in_service';
    }
  }

  this.updatedAt = new Date();
  next();
});

// Virtual for monthly depreciation amount
fixedAssetSchema.virtual('monthlyDepreciation').get(function() {
  if (!this.purchaseCost || !this.usefulLifeMonths) return 0;
  
  const purchaseCost = typeof this.purchaseCost === 'object' 
    ? parseFloat(this.purchaseCost.toString()) 
    : this.purchaseCost;
  const salvage = typeof this.salvageValue === 'object' 
    ? parseFloat(this.salvageValue.toString()) 
    : this.salvageValue;
  
  if (this.depreciationMethod === 'straight_line') {
    return (purchaseCost - salvage) / this.usefulLifeMonths;
  }
  
  // For declining balance, this is just the current year rate
  if (this.decliningRate) {
    const rate = typeof this.decliningRate === 'object' 
      ? parseFloat(this.decliningRate.toString()) 
      : this.decliningRate;
    const nbv = typeof this.netBookValue === 'object' 
      ? parseFloat(this.netBookValue.toString()) 
      : this.netBookValue;
    return nbv * rate;
  }
  
  return 0;
});

// Method to calculate depreciation for a period
fixedAssetSchema.methods.calculateDepreciation = function(periodDate = new Date()) {
  const purchaseCost = typeof this.purchaseCost === 'object'
    ? parseFloat(this.purchaseCost.toString())
    : this.purchaseCost;
  const salvage = typeof this.salvageValue === 'object'
    ? parseFloat(this.salvageValue.toString())
    : this.salvageValue;
  const accumDep = typeof this.accumulatedDepreciation === 'object'
    ? parseFloat(this.accumulatedDepreciation.toString())
    : this.accumulatedDepreciation;

  const depreciableAmount = purchaseCost - salvage;

  // Already fully depreciated (NBV has reached salvage value)
  if (accumDep >= depreciableAmount) {
    return 0;
  }

  // CRITICAL: Use inServiceDate, not purchaseDate for depreciation start
  const effectiveStartDate = this.inServiceDate || this.purchaseDate;

  // If asset not yet in service, no depreciation
  if (!effectiveStartDate || periodDate < effectiveStartDate) {
    return 0;
  }

  let depreciationAmount = 0;

  if (this.depreciationMethod === 'straight_line') {
    // Monthly depreciation
    depreciationAmount = depreciableAmount / this.usefulLifeMonths;

    // Apply partial-month convention for first month
    const isFirstMonth = this._isFirstDepreciationMonth(periodDate, effectiveStartDate);
    if (isFirstMonth) {
      depreciationAmount = this._applyPartialMonthConvention(depreciationAmount, effectiveStartDate);
    }
  } else if (this.depreciationMethod === 'declining_balance') {
    // Declining balance based on current NBV
    const rate = this.decliningRate
      ? (typeof this.decliningRate === 'object' ? parseFloat(this.decliningRate.toString()) : this.decliningRate)
      : 0.2; // Default 20% if not specified
    const nbvVal = purchaseCost - accumDep;
    depreciationAmount = nbvVal * rate / 12; // Monthly amount
  }

  // CRITICAL: Cap depreciation so NBV never goes below salvage value
  // Use Math.min to prevent over-depreciation in final month(s)
  const remainingDepreciable = depreciableAmount - accumDep;
  depreciationAmount = Math.min(depreciationAmount, remainingDepreciable);

  return Math.round(depreciationAmount * 100) / 100;
};

// Check if this is the first depreciation month
fixedAssetSchema.methods._isFirstDepreciationMonth = function(periodDate, startDate) {
  const periodYear = periodDate.getFullYear();
  const periodMonth = periodDate.getMonth();
  const startYear = startDate.getFullYear();
  const startMonth = startDate.getMonth();

  return periodYear === startYear && periodMonth === startMonth;
};

// Apply partial-month convention (mid-month convention)
// If placed in service by 15th: full month depreciation
// If placed in service after 15th: half month depreciation
fixedAssetSchema.methods._applyPartialMonthConvention = function(fullMonthAmount, inServiceDate) {
  const serviceDay = inServiceDate.getDate();

  // Mid-month convention
  if (serviceDay <= 15) {
    return fullMonthAmount;  // Full month
  } else {
    return fullMonthAmount / 2;  // Half month
  }
};

// Alternative: Actual days convention (more precise, for future use)
fixedAssetSchema.methods._applyActualDaysConvention = function(fullMonthAmount, inServiceDate, periodDate) {
  const daysInMonth = new Date(
    periodDate.getFullYear(),
    periodDate.getMonth() + 1,
    0
  ).getDate();

  const serviceDay = inServiceDate.getDate();
  const daysInService = daysInMonth - serviceDay + 1;

  return (fullMonthAmount / daysInMonth) * daysInService;
};

// Calculate partial month depreciation for disposal
fixedAssetSchema.methods.calculatePartialMonthDepreciation = function(disposalDate) {
  const effectiveStartDate = this.inServiceDate || this.purchaseDate;

  // If disposed in same month as placed in service, calculate based on actual days
  const isSameMonth =
    disposalDate.getFullYear() === effectiveStartDate.getFullYear() &&
    disposalDate.getMonth() === effectiveStartDate.getMonth();

  if (isSameMonth) {
    // Calculate based on days in service
    const daysInMonth = new Date(
      disposalDate.getFullYear(),
      disposalDate.getMonth() + 1,
      0
    ).getDate();

    const serviceDay = effectiveStartDate.getDate();
    const disposalDay = disposalDate.getDate();
    const daysInService = disposalDay - serviceDay + 1;

    const purchaseCost = typeof this.purchaseCost === 'object'
      ? parseFloat(this.purchaseCost.toString())
      : this.purchaseCost;
    const salvage = typeof this.salvageValue === 'object'
      ? parseFloat(this.salvageValue.toString())
      : this.salvageValue;
    const depreciableAmount = purchaseCost - salvage;
    const monthlyDep = depreciableAmount / this.usefulLifeMonths;

    return (monthlyDep / daysInMonth) * daysInService;
  }

  // Otherwise use standard calculation for the final month
  return this.calculateDepreciation(disposalDate);
};

// Static method to generate reference number
fixedAssetSchema.statics.generateReferenceNo = async function(companyId) {
  const seq = await nextSequence(companyId, 'fixed_asset');
  const year = new Date().getFullYear();
  return `AST-${year}-${seq}`;
};

// Ensure virtuals are serialized and Decimal128 values are converted to numbers
fixedAssetSchema.set('toJSON', { 
  virtuals: true,
  transform: function(doc, ret) {
    // Convert Decimal128 values to numbers
    const decimalFields = ['purchaseCost', 'salvageValue', 'insuredValue', 'accumulatedDepreciation', 'netBookValue', 'decliningRate'];
    decimalFields.forEach(field => {
      if (ret[field] && typeof ret[field] === 'object' && ret[field].$numberDecimal) {
        ret[field] = parseFloat(ret[field].$numberDecimal);
      }
    });
    return ret;
  }
});
fixedAssetSchema.set('toObject', { virtuals: true });

const FixedAsset = mongoose.model('FixedAsset', fixedAssetSchema);

/**
 * Depreciation Entry Model
 * 
 * Records individual depreciation entries for fixed assets.
 */
const depreciationEntrySchema = new mongoose.Schema({
  // Company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },

  // Asset reference
  asset: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FixedAsset',
    required: true
  },

  // Period this depreciation covers
  periodDate: {
    type: Date,
    required: true
  },

  // Depreciation amounts
  depreciationAmount: {
    type: mongoose.Schema.Types.Decimal128,
    required: true
  },
  accumulatedBefore: {
    type: mongoose.Schema.Types.Decimal128,
    required: true
  },
  accumulatedAfter: {
    type: mongoose.Schema.Types.Decimal128,
    required: true
  },
  netBookValueAfter: {
    type: mongoose.Schema.Types.Decimal128,
    required: true
  },

  // Journal entry reference
  journalEntryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'JournalEntry',
    required: true
  },

  // Posted by
  postedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  // Status
  isReversed: {
    type: Boolean,
    default: false
  },
  reversedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  reversedAt: {
    type: Date,
    default: null
  },

  // Soft delete
  isDeleted: {
    type: Boolean,
    default: false
  },
  deletedAt: {
    type: Date,
    default: null
  },

  // Tracking
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Indexes
depreciationEntrySchema.index({ company: 1, asset: 1, periodDate: 1 }, { unique: true });
depreciationEntrySchema.index({ company: 1, periodDate: 1 });

// Pre-save
depreciationEntrySchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

const DepreciationEntry = mongoose.model('DepreciationEntry', depreciationEntrySchema);

// Export so that callers can `const FixedAsset = require('./models/FixedAsset')`
// or destructure `const { FixedAsset, DepreciationEntry } = require('./models/FixedAsset')`.
module.exports = FixedAsset;
module.exports.FixedAsset = FixedAsset;
module.exports.DepreciationEntry = DepreciationEntry;
