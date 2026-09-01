/**
 * Backup Scheduler Service
 * Automates database backups on a schedule
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// Import config
const env = require('../src/config/environment');
const config = env.getConfig();

const BACKUP_DIR = process.env.BACKUP_DIR || './backups';
const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS, 10) || 30;
const AUTO_BACKUP_ENABLED = process.env.AUTO_BACKUP_ENABLED === 'true';

class BackupScheduler {
  constructor() {
    this.timers = [];       // Track ALL timers to prevent leaks
    this.backupTimer = null;
    this.isRunning = false;
    this.started = false;   // Guard against double-start
  }

  /**
   * Register a timer/interval so it can be cleaned up on stop/restart.
   */
  _registerTimer(timer) {
    this.timers.push(timer);
    return timer;
  }

  /**
   * Clear all registered timers.
   */
  _clearAllTimers() {
    for (const t of this.timers) {
      if (typeof t === 'number') {
        clearTimeout(t);
        clearInterval(t);
      }
    }
    this.timers = [];
    this.backupTimer = null;
  }

  /**
   * Start the backup scheduler
   */
  startBackupScheduler() {
    if (!AUTO_BACKUP_ENABLED) {
      console.log('📦 Auto-backup is disabled (AUTO_BACKUP_ENABLED=false)');
      return;
    }
    if (this.started) {
      console.log('📦 Backup scheduler already running, skipping duplicate start');
      return;
    }
    this.started = true;

    // Backup schedule: Daily at 2am
    const schedule = process.env.BACKUP_CRON || '0 2 * * *';
    
    console.log(`📦 Backup scheduler started (cron: ${schedule})`);
    
    // For simplicity, we'll use a simple interval in development
    // In production, use node-cron or similar
    if (process.env.NODE_ENV === 'development') {
      // For development, run every hour for testing
      this.backupTimer = this._registerTimer(setInterval(() => {
        this.runBackup();
      }, 60 * 60 * 1000)); // 1 hour
    } else {
      // Production: daily at 2am
      this.scheduleCronBackup(schedule);
    }

    // Run initial backup on start (delayed)
    this._registerTimer(setTimeout(() => {
      this.runBackup();
    }, 30000)); // Wait 30 seconds after startup
  }

  /**
   * Schedule cron-based backup
   */
  scheduleCronBackup(cronExpression) {
    // Simple cron parser (basic support)
    // In production, use node-cron package
    console.log(`📦 Cron backup scheduled: ${cronExpression}`);
    
    // For now, use setInterval as fallback
    // In production, replace with proper cron
    const now = new Date();
    const hoursUntil2AM = (2 - now.getHours() + 24) % 24;
    const msUntil2AM = hoursUntil2AM * 60 * 60 * 1000;
    
    this._registerTimer(setTimeout(() => {
      this.runBackup();
      this.backupTimer = this._registerTimer(setInterval(() => {
        this.runBackup();
      }, 24 * 60 * 60 * 1000)); // Daily
    }, msUntil2AM));
  }

  /**
   * Run backup
   */
  async runBackup() {
    if (this.isRunning) {
      console.log('📦 Backup already in progress, skipping...');
      return;
    }

    this.isRunning = true;
    console.log('📦 Starting database backup...');

    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dbName = config.db.uri.split('/').pop().split('?')[0];
      const backupFile = path.join(BACKUP_DIR, `backup_${dbName}_${timestamp}.gz`);

      // Ensure backup directory exists
      if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
      }

      // Get MongoDB URI (remove database name for mongodump)
      const mongoUri = config.db.uri;

      // Run mongodump
      const dumpCmd = `mongodump --uri="${mongoUri}" --archive=${backupFile} --gzip`;
      await execAsync(dumpCmd);

      // Verify backup was created
      if (fs.existsSync(backupFile)) {
        const stats = fs.statSync(backupFile);
        console.log(`✅ Backup created: ${backupFile} (${Math.round(stats.size / 1024 / 1024)}MB)`);
        
        // Upload to cloud if configured
        await this.uploadBackup(backupFile);
        
        // Clean old backups
        await this.cleanOldBackups();
        
        console.log('📦 Backup completed successfully');
      } else {
        throw new Error('Backup file not created');
      }
    } catch (err) {
      console.error('❌ Backup failed:', err.message);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Upload backup to cloud storage
   */
  async uploadBackup(backupFile) {
    // Check if cloud backup is enabled
    const cloudBackupEnabled = config.features.cloudBackup;
    
    if (!cloudBackupEnabled) {
      console.log('📦 Cloud backup disabled, skipping upload');
      return;
    }

    try {
      // Check for cloud provider
      if (process.env.AWS_S3_BUCKET) {
        await this.uploadToS3(backupFile);
      } else if (process.env.GOOGLE_DRIVE_FOLDER_ID) {
        await this.uploadToGoogleDrive(backupFile);
      } else if (process.env.DROPBOX_ACCESS_TOKEN) {
        await this.uploadToDropbox(backupFile);
      }
    } catch (err) {
      console.error('⚠️  Cloud upload failed:', err.message);
    }
  }

  /**
   * Upload to AWS S3
   */
  async uploadToS3(backupFile) {
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const fs = require('fs');
    
    const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
    const fileName = path.basename(backupFile);
    
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: `backups/${fileName}`,
      Body: fs.createReadStream(backupFile),
      ContentType: 'application/gzip',
    }));
    
    console.log('✅ Backup uploaded to S3');
  }

  /**
   * Upload to Google Drive (using googleDriveService)
   */
  async uploadToGoogleDrive(backupFile) {
    const googleDriveService = require('./googleDriveService');
    await googleDriveService.uploadFile(backupFile);
    console.log('✅ Backup uploaded to Google Drive');
  }

  /**
   * Upload to Dropbox
   */
  async uploadToDropbox(backupFile) {
    const axios = require('axios');
    const fs = require('fs');
    const fileContent = fs.readFileSync(backupFile);
    const fileName = path.basename(backupFile);
    
    await axios({
      method: 'post',
      url: 'https://content.dropboxapi.com/2/files/upload',
      headers: {
        Authorization: `Bearer ${process.env.DROPBOX_ACCESS_TOKEN}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({
          path: `/backups/${fileName}`,
          mode: 'add',
          autorename: true,
        }),
      },
      data: fileContent,
    });
    
    console.log('✅ Backup uploaded to Dropbox');
  }

  /**
   * Clean up old backups
   */
  async cleanOldBackups() {
    console.log('📦 Cleaning old backups...');
    
    if (!fs.existsSync(BACKUP_DIR)) return;
    
    const files = fs.readdirSync(BACKUP_DIR);
    const now = Date.now();
    let deletedCount = 0;

    for (const file of files) {
      const filePath = path.join(BACKUP_DIR, file);
      const stats = fs.statSync(filePath);
      
      // Check if file is older than retention period
      const ageInDays = (now - stats.mtimeMs) / (1000 * 60 * 60 * 24);
      
      if (ageInDays > RETENTION_DAYS) {
        fs.unlinkSync(filePath);
        deletedCount++;
      }
    }

    console.log(`📦 Cleaned ${deletedCount} old backup(s)`);
  }

  /**
   * Stop the scheduler
   */
  stopBackupScheduler() {
    this._clearAllTimers();
    this.started = false;
    console.log('📦 Backup scheduler stopped');
  }
}

// Export singleton
const backupScheduler = new BackupScheduler();

// Auto-start if enabled
if (AUTO_BACKUP_ENABLED && process.env.NODE_ENV !== 'test') {
  try {
    backupScheduler.startBackupScheduler();
  } catch (err) {
    console.warn('⚠️  Could not start backup scheduler:', err.message);
  }
}

module.exports = backupScheduler;
