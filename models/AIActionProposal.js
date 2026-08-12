'use strict';

const mongoose = require('mongoose');

const AIActionProposalSchema = new mongoose.Schema({
  proposalId: {
    type: String,
    required: true,
    index: true,
  },
  company: {
    type: String,
    required: true,
    index: true,
  },
  createdBy: {
    type: String,
    required: true,
    index: true,
  },
  type: {
    type: String,
    enum: [
      'purchase_order_draft',
      'payment_reminder_draft',
      'stock_adjustment_review_request',
      'supplier_follow_up_task',
      'customer_follow_up_task',
    ],
    required: true,
    index: true,
  },
  status: {
    type: String,
    enum: ['draft', 'pending_approval', 'approved', 'rejected', 'executed', 'failed'],
    default: 'draft',
    index: true,
  },
  payload: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  evidenceFactIds: [{
    type: String,
  }],
  sourceRecommendationIds: [{
    type: String,
  }],
  sourceFindingIds: [{
    type: String,
  }],
  riskLevel: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    required: true,
    index: true,
  },
  approvalRequiredByRole: [{
    type: String,
  }],
  approvedBy: {
    type: String,
    default: null,
  },
  approvedAt: {
    type: Date,
    default: null,
  },
  rejectedBy: {
    type: String,
    default: null,
  },
  rejectedAt: {
    type: Date,
    default: null,
  },
  rejectionReason: {
    type: String,
    default: null,
  },
  executedBy: {
    type: String,
    default: null,
  },
  executedAt: {
    type: Date,
    default: null,
  },
  executionResult: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
}, {
  timestamps: true,
});

AIActionProposalSchema.index({ company: 1, proposalId: 1 }, { unique: true });
AIActionProposalSchema.index({ company: 1, status: 1, updatedAt: -1 });
AIActionProposalSchema.index({ company: 1, type: 1, status: 1 });

module.exports = mongoose.model('AIActionProposal', AIActionProposalSchema);
