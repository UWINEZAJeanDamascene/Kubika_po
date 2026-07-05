/**
 * ImportJob Model
 * Tracks every import operation across all import features
 * Multi-tenant with TTL auto-delete after 7 days
 */

const mongoose = require('mongoose');
const mongooseTenant = require('../../plugins/tenantPlugin');

const importJobSchema = new mongoose.Schema({
  // Multi-tenant scoping
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },

  // Import type
  type: {
    type: String,
    enum: ['products', 'clients', 'suppliers', 'opening_balance', 'bank_statement'],
    required: true
  },

  // Job status
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'completed_with_errors', 'failed'],
    default: 'pending'
  },

  // Row counts
  totalRows: {
    type: Number,
    default: 0
  },
  processedRows: {
    type: Number,
    default: 0
  },
  successfulRows: {
    type: Number,
    default: 0
  },
  failedRows: {
    type: Number,
    default: 0
  },

  // Error details
  errors: [{
    row: Number,
    field: String,
    message: String,
    value: String
  }],

  // File info
  fileName: {
    type: String,
    required: true
  },

  // Timestamps
  startedAt: {
    type: Date
  },
  completedAt: {
    type: Date
  },

  // User who initiated the import
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true,
  suppressReservedKeysWarning: true
});

// TTL: auto-delete completed/failed jobs after 7 days
importJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

// Compound index for company queries
importJobSchema.index({ company: 1, status: 1, createdAt: -1 });
importJobSchema.index({ company: 1, type: 1, createdAt: -1 });

// Apply tenant plugin
importJobSchema.plugin(mongooseTenant);

/**
 * Helper method to mark job as started
 */
importJobSchema.methods.startProcessing = function() {
  this.status = 'processing';
  this.startedAt = new Date();
  return this.save();
};

/**
 * Helper method to mark job as completed
 */
importJobSchema.methods.complete = function(result) {
  this.status = result.failedRows > 0 ? 'completed_with_errors' : 'completed';
  this.completedAt = new Date();
  this.processedRows = result.processedRows;
  this.successfulRows = result.successfulRows;
  this.failedRows = result.failedRows;
  this.errors = result.errors || [];
  return this.save();
};

/**
 * Helper method to mark job as failed
 */
importJobSchema.methods.fail = function(error) {
  this.status = 'failed';
  this.completedAt = new Date();
  this.errors = this.errors || [];
  this.errors.push({
    row: 0,
    field: 'import',
    message: error.message,
    value: ''
  });
  return this.save();
};

module.exports = mongoose.model('ImportJob', importJobSchema);