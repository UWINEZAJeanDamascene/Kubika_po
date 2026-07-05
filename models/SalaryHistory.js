const mongoose = require('mongoose');

const salaryHistorySchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },
  employee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true,
    index: true
  },
  basicSalary: {
    type: Number,
    required: true,
    min: 0
  },
  transportAllowance: {
    type: Number,
    default: 0
  },
  housingAllowance: {
    type: Number,
    default: 0
  },
  otherAllowances: {
    type: Number,
    default: 0
  },
  currency: {
    type: String,
    default: 'RWF',
    uppercase: true,
    trim: true
  },
  effectiveDate: {
    type: Date,
    required: true
  },
  endDate: {
    type: Date,
    default: null
  },
  reason: {
    type: String,
    trim: true,
    default: null
  },
  changedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true
});

// Indexes for effective salary lookups
salaryHistorySchema.index({ company: 1, employee: 1, effectiveDate: -1 });
// Partial index for currently active salaries
salaryHistorySchema.index(
  { company: 1, employee: 1, endDate: 1 },
  { partialFilterExpression: { endDate: null } }
);

// Static method: get the salary history row effective for a given date
salaryHistorySchema.statics.getEffectiveSalary = async function (employeeId, asOfDate) {
  const date = asOfDate instanceof Date ? asOfDate : new Date(asOfDate);
  const query = {
    employee: employeeId,
    effectiveDate: { $lte: date }
  };

  // Either endDate is null (still active) OR endDate >= the queried date
  query.$or = [
    { endDate: null },
    { endDate: { $gte: date } }
  ];

  const row = await this.findOne(query)
    .sort({ effectiveDate: -1 })
    .lean();

  return row || null;
};

// Static method: close any open salary history row for an employee
salaryHistorySchema.statics.closeActiveRow = async function (employeeId, closeDate, reason) {
  const closeAt = closeDate instanceof Date ? closeDate : new Date(closeDate);
  return this.updateMany(
    { employee: employeeId, endDate: null },
    { $set: { endDate: closeAt } }
  );
};

// Virtual for gross salary at this point in history
salaryHistorySchema.virtual('grossSalary').get(function () {
  return (this.basicSalary || 0)
    + (this.transportAllowance || 0)
    + (this.housingAllowance || 0)
    + (this.otherAllowances || 0);
});

module.exports = mongoose.model('SalaryHistory', salaryHistorySchema);
