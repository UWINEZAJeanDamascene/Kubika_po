/**
 * Asset Disposal Event Model
 *
 * Records complete disposal transactions for fixed assets.
 * Required for audit trails, RRA compliance, and gain/loss tracking.
 */

const mongoose = require('mongoose');

const assetDisposalEventSchema = new mongoose.Schema({
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
    required: true,
    index: true
  },

  // Disposal details
  disposalDate: {
    type: Date,
    required: true
  },
  disposalMethod: {
    type: String,
    enum: ['sale', 'scrap', 'donation', 'trade_in', 'theft_loss', 'transfer'],
    required: true
  },

  // Financials
  grossProceeds: {
    type: mongoose.Schema.Types.Decimal128,
    default: mongoose.Types.Decimal128.fromString('0')
  },
  disposalCosts: {
    type: mongoose.Schema.Types.Decimal128,
    default: mongoose.Types.Decimal128.fromString('0')
  },
  netProceeds: {
    type: mongoose.Schema.Types.Decimal128,
    required: true
  },

  // Book values at disposal
  originalCost: {
    type: mongoose.Schema.Types.Decimal128,
    required: true
  },
  accumulatedDepreciation: {
    type: mongoose.Schema.Types.Decimal128,
    required: true
  },
  netBookValue: {
    type: mongoose.Schema.Types.Decimal128,
    required: true
  },

  // Calculated gain/loss
  gainLoss: {
    type: mongoose.Schema.Types.Decimal128,
    required: true
  },
  gainLossType: {
    type: String,
    enum: ['gain', 'loss', 'break_even'],
    required: true
  },

  // Journal entries created
  disposalJournalEntryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'JournalEntry',
    default: null
  },

  // For trade-ins
  tradeInAssetId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FixedAsset',
    default: null
  },
  tradeInValue: {
    type: mongoose.Schema.Types.Decimal128,
    default: null
  },

  // Sale details
  soldToCustomerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    default: null
  },
  saleInvoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice',
    default: null
  },

  // Bank account for proceeds
  proceedsBankAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BankAccount',
    default: null
  },

  // RRA compliance - disposal authorization
  disposalAuthNumber: {
    type: String,
    default: null
  },
  rraNotified: {
    type: Boolean,
    default: false
  },
  rraNotificationDate: {
    type: Date,
    default: null
  },

  // Supporting documents
  attachments: [{
    fileName: String,
    fileUrl: String,
    fileType: String,
    uploadedAt: {
      type: Date,
      default: Date.now
    }
  }],

  // Audit
  processedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  processedAt: {
    type: Date,
    default: Date.now
  },

  // Notes
  notes: {
    type: String,
    maxlength: 2000,
    default: null
  },

  // Reversal info (if disposal is reversed)
  isReversed: {
    type: Boolean,
    default: false
  },
  reversedAt: {
    type: Date,
    default: null
  },
  reversedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  reversalReason: {
    type: String,
    default: null
  }
});

// Indexes
assetDisposalEventSchema.index({ company: 1, asset: 1 });
assetDisposalEventSchema.index({ company: 1, disposalDate: -1 });
assetDisposalEventSchema.index({ company: 1, disposalMethod: 1 });
assetDisposalEventSchema.index({ company: 1, gainLossType: 1 });
// Ensure one non-reversed disposal event per asset
assetDisposalEventSchema.index(
  { asset: 1, isReversed: 1 },
  {
    unique: true,
    partialFilterExpression: { isReversed: false }
  }
);

// Virtual for gain/loss percentage
assetDisposalEventSchema.virtual('gainLossPercentage').get(function() {
  const nbv = parseFloat(this.netBookValue?.toString() || 0);
  const gainLoss = parseFloat(this.gainLoss?.toString() || 0);
  if (nbv === 0) return gainLoss > 0 ? 100 : 0;
  return (gainLoss / nbv) * 100;
});

// Static method to get disposal summary for a company
assetDisposalEventSchema.statics.getDisposalSummary = async function(companyId, dateRange = {}) {
  const match = { company: companyId, isReversed: false };

  if (dateRange.from || dateRange.to) {
    match.disposalDate = {};
    if (dateRange.from) match.disposalDate.$gte = new Date(dateRange.from);
    if (dateRange.to) match.disposalDate.$lte = new Date(dateRange.to);
  }

  const summary = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalDisposals: { $sum: 1 },
        totalProceeds: { $sum: '$netProceeds' },
        totalGain: {
          $sum: {
            $cond: [{ $eq: ['$gainLossType', 'gain'] }, '$gainLoss', 0]
          }
        },
        totalLoss: {
          $sum: {
            $cond: [{ $eq: ['$gainLossType', 'loss'] }, '$gainLoss', 0]
          }
        },
        gainsCount: {
          $sum: { $cond: [{ $eq: ['$gainLossType', 'gain'] }, 1, 0] }
        },
        lossesCount: {
          $sum: { $cond: [{ $eq: ['$gainLossType', 'loss'] }, 1, 0] }
        }
      }
    }
  ]);

  return summary[0] || {
    totalDisposals: 0,
    totalProceeds: 0,
    totalGain: 0,
    totalLoss: 0,
    gainsCount: 0,
    lossesCount: 0
  };
};

// Ensure virtuals are serialized
assetDisposalEventSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    // Convert Decimal128 values to numbers
    const decimalFields = [
      'grossProceeds', 'disposalCosts', 'netProceeds',
      'originalCost', 'accumulatedDepreciation', 'netBookValue',
      'gainLoss', 'tradeInValue'
    ];
    decimalFields.forEach(field => {
      if (ret[field] && typeof ret[field] === 'object' && ret[field].$numberDecimal) {
        ret[field] = parseFloat(ret[field].$numberDecimal);
      }
    });
    return ret;
  }
});

const AssetDisposalEvent = mongoose.model('AssetDisposalEvent', assetDisposalEventSchema);

module.exports = AssetDisposalEvent;
