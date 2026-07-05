const mongoose = require('mongoose');

const subscriptionPlanSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true,
    default: ''
  },
  features: [{
    type: String,
    trim: true
  }],
  modules: [{
    type: String,
    trim: true
  }],
  outcomes: [{
    type: String,
    trim: true
  }],
  badge: {
    type: String,
    trim: true,
    default: ''
  },
  icon: {
    type: String,
    trim: true,
    default: ''
  },
  featured: {
    type: Boolean,
    default: false
  },
  button_label: {
    type: String,
    trim: true,
    default: ''
  },
  default_billing_amount: {
    type: Number,
    default: 0,
    min: 0
  },
  default_billing_cycle: {
    type: String,
    enum: ['monthly', 'quarterly', 'annual'],
    default: 'monthly'
  },
  is_active: {
    type: Boolean,
    default: true
  },
  sort_order: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

subscriptionPlanSchema.index({ is_active: 1 });

module.exports = mongoose.model('SubscriptionPlan', subscriptionPlanSchema);
