const mongoose = require('mongoose');

const tillSessionSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  openedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: { type: String, enum: ['open', 'closed'], default: 'open', index: true },
  openingFloat: { type: Number, default: 0, min: 0 },
  closingCount: { type: Number, min: 0 },
  openedAt: { type: Date, default: Date.now },
  closedAt: { type: Date },
});

// Ensure only one open session per user/company
tillSessionSchema.index({ company: 1, openedBy: 1, status: 1 });

const TillSession = mongoose.model('TillSession', tillSessionSchema);
module.exports = TillSession;
