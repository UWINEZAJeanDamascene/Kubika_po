const mongoose = require('mongoose');

const backupSchema = new mongoose.Schema({
  // Company reference for multi-tenancy
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Backup must belong to a company']
  },
  // Backup name/label
  name: {
    type: String,
    required: [true, 'Backup name is required'],
    trim: true
  },
  // Backup type
  type: {
    type: String,
    enum: ['manual', 'automated', 'scheduled'],
    default: 'manual'
  },
  // Backup status
  status: {
    type: String,
    // 'completed_with_errors': the archive was written, but at least one
    // collection could not be read (or had no usable model). Distinguishing it
    // from 'completed' matters — a partial archive must not be mistaken for a
    // full one at restore time.
    enum: ['pending', 'in_progress', 'completed', 'completed_with_errors', 'failed', 'verified', 'restoring'],
    default: 'pending'
  },
  // Storage location (local, cloud, etc.)
  storageLocation: {
    type: String,
    enum: ['local', 'cloud', 's3', 'google-drive', 'dropbox'],
    default: 'local'
  },
  // Cloud storage URL (if applicable)
  cloudUrl: {
    type: String,
    default: null
  },
  // Local file path
  filePath: {
    type: String,
    default: null
  },
  // File size in bytes
  fileSize: {
    type: Number,
    default: 0
  },
  // Compression format
  compressionFormat: {
    type: String,
    enum: ['none', 'gzip', 'zip'],
    default: 'gzip'
  },
  // Database version at time of backup
  mongoVersion: {
    type: String,
    default: ''
  },
  // Point-in-time recovery timestamp (optional)
  pointInTime: {
    type: Date,
    default: null
  },
  // Collections included in backup
  collections: [{
    name: String,
    documentCount: Number
  }],
  // Verification status
  verification: {
    verified: {
      type: Boolean,
      default: false
    },
    verifiedAt: {
      type: Date,
      default: null
    },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    checksum: {
      type: String,
      default: null
    },
    integrityStatus: {
      type: String,
      enum: ['not_verified', 'valid', 'corrupted', 'missing'],
      default: 'not_verified'
    },
    errorMessage: {
      type: String,
      default: null
    }
  },
  // Error message if backup failed
  errorMessage: {
    type: String,
    default: null
  },
  // Restore information
  restore: {
    restoredAt: {
      type: Date,
      default: null
    },
    restoredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    originalBackupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Backup',
      default: null
    }
  },
  // Backup schedule (for automated backups)
  schedule: {
    enabled: {
      type: Boolean,
      default: false
    },
    frequency: {
      type: String,
      enum: ['hourly', 'daily', 'weekly', 'monthly', 'custom'],
      default: 'daily'
    },
    cronExpression: {
      type: String,
      default: null
    },
    lastRun: {
      type: Date,
      default: null
    },
    nextRun: {
      type: Date,
      default: null
    }
  },
  // Retention policy
  retention: {
    keepForDays: {
      type: Number,
      default: 30
    },
    autoDelete: {
      type: Boolean,
      default: true
    }
  },
  // Metadata
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  // Cloud provider settings
  cloudConfig: {
    provider: {
      type: String,
      enum: ['aws', 'gcp', 'azure', 'local'],
      default: 'local'
    },
    bucket: {
      type: String,
      default: null
    },
    region: {
      type: String,
      default: null
    }
  }
}, {
  timestamps: true
});

// Indexes for efficient querying
backupSchema.index({ company: 1, createdAt: -1 });
backupSchema.index({ company: 1, status: 1 });
backupSchema.index({ company: 1, type: 1 });
backupSchema.index({ 'schedule.nextRun': 1 });

// Virtual for formatted file size
backupSchema.virtual('formattedSize').get(function() {
  if (this.fileSize === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(this.fileSize) / Math.log(k));
  return parseFloat((this.fileSize / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
});

// Method to mark as verified
backupSchema.methods.markAsVerified = function(verifiedBy, checksum) {
  this.verification.verified = true;
  this.verification.verifiedAt = new Date();
  this.verification.verifiedBy = verifiedBy;
  this.verification.checksum = checksum;
  // The checksum proves the FILE is intact. It says nothing about whether every
  // collection made it into that file.
  this.verification.integrityStatus = 'valid';
  // Preserve a partial result. Promoting 'completed_with_errors' to 'verified'
  // would launder an incomplete archive past the restore guard — the archive is
  // still missing collections however well its bytes check out.
  if (this.status !== 'completed_with_errors') {
    this.status = 'verified';
  }
  return this.save();
};

// Method to mark as failed
backupSchema.methods.markAsFailed = function(errorMessage) {
  this.status = 'failed';
  this.errorMessage = errorMessage;
  return this.save();
};

module.exports = mongoose.model('Backup', backupSchema);
