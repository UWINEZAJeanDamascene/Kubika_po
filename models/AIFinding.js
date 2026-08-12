'use strict';

const mongoose = require('mongoose');

const AIFindingSchema = new mongoose.Schema({
  findingId: {
    type: String,
    required: true,
    index: true,
  },
  company: {
    type: String,
    required: true,
    index: true,
  },
  domain: {
    type: String,
    required: true,
    index: true,
  },
  ruleId: {
    type: String,
    required: true,
    index: true,
  },
  title: {
    type: String,
    required: true,
    trim: true,
  },
  summary: {
    type: String,
    required: true,
    trim: true,
  },
  severity: {
    type: String,
    enum: ['info', 'low', 'medium', 'high', 'critical'],
    required: true,
    index: true,
  },
  confidence: {
    type: Number,
    min: 0,
    max: 1,
    required: true,
  },
  evidenceFactIds: [{
    type: String,
  }],
  recommendedNextStep: {
    type: String,
    trim: true,
  },
  status: {
    type: String,
    enum: ['open', 'acknowledged', 'dismissed', 'resolved'],
    default: 'open',
    index: true,
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  firstDetectedAt: {
    type: Date,
    default: Date.now,
  },
  lastDetectedAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
  occurrenceCount: {
    type: Number,
    default: 1,
    min: 1,
  },
}, {
  timestamps: true,
});

AIFindingSchema.index({ company: 1, findingId: 1 }, { unique: true });
AIFindingSchema.index({ company: 1, status: 1, severity: 1 });
AIFindingSchema.index({ company: 1, domain: 1, lastDetectedAt: -1 });

module.exports = mongoose.model('AIFinding', AIFindingSchema);
