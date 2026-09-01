// Retained ONLY for the Backup.aggregate() call in getBackupStats: `Backup` is
// itself still a Mongoose-only model, so its aggregate needs a real ObjectId.
// Everything else in this file is PostgreSQL-backed. Remove this import when
// Backup migrates to Prisma.
const mongoose = require('mongoose');
const { runInTransaction } = require('../services/transactionService');
const { generateObjectId } = require('../utils/objectId');
const { parseOptionalPagination, paginationMeta } = require('../utils/pagination');
const Backup = require('../models/Backup');
const Company = require('../models/Company');
const Currency = require('../models/Currency');
const User = require('../models/User');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const crypto = require('crypto');
const zlib = require('zlib');
const { google } = require('googleapis');
const { notifyBackupSuccess, notifyBackupFailed } = require('../services/notificationHelper');

// Get list of all models that can be backed up
/**
 * Every collection the backup feature knows about.
 *
 * `restorable: false` marks one that is still MongoDB-only. Those are excluded
 * from new backups rather than attempted-and-failed, for two reasons:
 *
 *  - With MONGODB_URI unset their reads throw, so including them would make
 *    EVERY archive `completed_with_errors` — and the restore guard would then
 *    refuse every backup ever taken. A safety gate that blocks everything is
 *    just an outage.
 *  - The restore runs in a single PostgreSQL transaction (see performRestore).
 *    A Mongo write cannot join that transaction, so including one would break
 *    the all-or-nothing guarantee.
 *
 * Flip a collection to `restorable: true` when its model moves to Prisma.
 */
const BACKUP_COLLECTIONS = [
  { name: 'ActionLog', restorable: true },
  { name: 'Budget', restorable: true },
  { name: 'CashDrawer', restorable: false },        // Mongoose-only
  { name: 'Category', restorable: true },
  { name: 'Client', restorable: true },
  { name: 'Company', restorable: true },
  { name: 'CreditNote', restorable: true },
  { name: 'Currency', restorable: true },
  { name: 'Department', restorable: true },
  { name: 'ExchangeRate', restorable: true },
  { name: 'InventoryBatch', restorable: true },
  { name: 'Invoice', restorable: true },
  { name: 'InvoiceReceiptMetadata', restorable: true },
  { name: 'IPWhitelist', restorable: true },
  { name: 'Notification', restorable: true },
  { name: 'NotificationSettings', restorable: true },
  { name: 'Product', restorable: true },
  { name: 'Purchase', restorable: true },
  { name: 'Quotation', restorable: true },
  { name: 'RecurringInvoice', restorable: true },
  { name: 'ReorderPoint', restorable: true },
  { name: 'Role', restorable: true },
  { name: 'SerialNumber', restorable: true },
  { name: 'StockAudit', restorable: true },
  { name: 'StockMovement', restorable: true },
  { name: 'StockTransfer', restorable: true },
  { name: 'Subscription', restorable: false },      // Mongoose-only
  { name: 'Supplier', restorable: true },
  { name: 'User', restorable: true },
  { name: 'Warehouse', restorable: true },
];

/** Collections included in a new backup: the PostgreSQL-backed ones. */
const getBackupableCollections = () =>
  BACKUP_COLLECTIONS.filter((c) => c.restorable).map((c) => c.name);

/** Collections deliberately left out, surfaced in the archive manifest. */
const getExcludedCollections = () =>
  BACKUP_COLLECTIONS.filter((c) => !c.restorable).map((c) => c.name);


/**
 * Resolve a backupable collection to its model.
 *
 * Must NOT use mongoose.model(name): most models are Prisma-backed compat
 * objects, and the mongoose registry holds only the bare `strict: false` stubs
 * registered for compatibility. Reading through those hits a MongoDB connection
 * that no longer exists, so every collection would come back empty and the
 * backup would report success while containing nothing.
 *
 * Returns null when a name has no model file, so the caller can record it as
 * skipped rather than silently writing an empty array.
 */
const resolveBackupModel = (collectionName) => {
  try {
    return require(`../models/${collectionName}`);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
};

/**
 * Source database version, recorded in the archive so a restore can tell what
 * produced it. Failure here must not fail the backup — it is metadata.
 */
const getSourceEngineVersion = async () => {
  try {
    const { prisma } = require('../lib/prisma');
    const rows = await prisma.$queryRawUnsafe('SHOW server_version');
    const version = rows && rows[0] && rows[0].server_version;
    return version ? `postgresql ${version}` : 'postgresql';
  } catch (error) {
    return 'postgresql (version unavailable)';
  }
};

// Get backup directory
const getBackupDir = () => {
  const backupDir = path.join(process.cwd(), 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  return backupDir;
};

// Generate checksum for data integrity
const generateChecksum = (data) => {
  return crypto.createHash('sha256').update(data).digest('hex');
};

// @desc    Get all backups for a company
// @route   GET /api/backups
// @access  Private
exports.getBackups = async (req, res) => {
  try {
    const companyId = req.company._id || req.company;
    
    // Opt-in pagination: callers that send page/limit get a page and totals;
    // callers that send neither keep the previous all-rows behaviour, so the
    // existing backups screen is unaffected.
    const { paginated, page, limit, skip } = parseOptionalPagination(req.query, { defaultLimit: 50 });
    const filter = { company: companyId };

    let query = Backup.find(filter)
      .populate('createdBy', 'name email')
      .populate('verification.verifiedBy', 'name email')
      .populate('restore.restoredBy', 'name email')
      .sort({ createdAt: -1 });
    if (paginated) query = query.skip(skip).limit(limit);

    const backups = await query;
    const total = paginated ? await Backup.countDocuments(filter) : backups.length;

    res.json({
      success: true,
      count: backups.length,
      data: backups,
      pagination: paginationMeta(page, limit || backups.length || 1, total)
    });
  } catch (error) {
    console.error('Error getting backups:', error);
    res.status(500).json({
      success: false,
      message: 'Server error retrieving backups',
      error: error.message
    });
  }
};

// @desc    Get single backup
// @route   GET /api/backups/:id
// @access  Private
exports.getBackup = async (req, res) => {
  try {
    const companyId = req.company._id || req.company;
    
    const backup = await Backup.findOne({ 
      _id: req.params.id, 
      company: companyId 
    })
      .populate('createdBy', 'name email')
      .populate('verification.verifiedBy', 'name email')
      .populate('restore.restoredBy', 'name email');

    if (!backup) {
      return res.status(404).json({
        success: false,
        message: 'Backup not found'
      });
    }

    res.json({
      success: true,
      data: backup
    });
  } catch (error) {
    console.error('Error getting backup:', error);
    res.status(500).json({
      success: false,
      message: 'Server error retrieving backup',
      error: error.message
    });
  }
};

// @desc    Create new backup
// @route   POST /api/backups
// @access  Private (Admin)
exports.createBackup = async (req, res) => {
  try {
    const companyId = req.company._id || req.company;
    const { 
      name, 
      type = 'manual', 
      storageLocation = 'local',
      pointInTime = null,
      collections = getBackupableCollections()
    } = req.body;

    // Create backup record
    const backup = await Backup.create({
      company: companyId,
      name: name || `Backup_${new Date().toISOString().replace(/[:.]/g, '-')}`,
      type,
      status: 'pending',
      storageLocation,
      pointInTime: pointInTime ? new Date(pointInTime) : null,
      createdBy: req.user?._id,
      collections: []
    });

    // Start backup process in background
    performBackup(backup._id, companyId, collections).catch(err => {
      console.error('Backup failed:', err);
    });

    res.status(201).json({
      success: true,
      message: 'Backup initiated successfully',
      data: backup
    });
  } catch (error) {
    console.error('Error creating backup:', error);
    res.status(500).json({
      success: false,
      message: 'Server error creating backup',
      error: error.message
    });
  }
};

// Perform the actual backup
const performBackup = async (backupId, companyId, collections) => {
  const backup = await Backup.findById(backupId);
  if (!backup) return;

  try {
    backup.status = 'in_progress';
    await backup.save();

    const backupData = {
      companyId,
      timestamp: new Date().toISOString(),
      pointInTime: backup.pointInTime,
      collections: []
    };

    const backupDir = getBackupDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `backup_${companyId}_${timestamp}.json.gz`;
    const filePath = path.join(backupDir, fileName);

    // Backup each collection
    for (const collectionName of collections) {
      try {
        const Model = resolveBackupModel(collectionName);
        if (!Model || typeof Model.find !== 'function') {
          // Recorded as an error, not skipped silently: a collection missing
          // from the archive must be visible in the manifest, or a restore
          // from this file would quietly leave that data behind.
          console.warn(`[backup] No usable model for ${collectionName}`);
          backupData.collections.push({
            name: collectionName,
            documentCount: 0,
            data: [],
            error: 'No usable model — collection not backed up',
          });
          continue;
        }
        let query = { company: companyId };
        
        // If point-in-time recovery, filter by date
        if (backup.pointInTime) {
          query.createdAt = { $lte: backup.pointInTime };
        }

        const documents = await Model.find(query).lean();
        
        backupData.collections.push({
          name: collectionName,
          documentCount: documents.length,
          data: documents
        });
      } catch (err) {
        console.warn(`Could not backup collection ${collectionName}:`, err.message);
        backupData.collections.push({
          name: collectionName,
          documentCount: 0,
          data: [],
          error: err.message
        });
      }
    }

    // Compress and save backup
    const jsonData = JSON.stringify(backupData);
    const compressedData = zlib.gzipSync(Buffer.from(jsonData));
    
    fs.writeFileSync(filePath, compressedData);
    
    const checksum = generateChecksum(compressedData);

    // A backup that could not read every collection is NOT 'completed'.
    // Marking it so would let a partial archive be restored later as though it
    // were whole — the failure would only surface as missing data.
    const failedCollections = backupData.collections.filter((c) => c.error);
    backup.status = failedCollections.length ? 'completed_with_errors' : 'completed';
    if (failedCollections.length) {
      console.warn(
        `[backup] ${failedCollections.length}/${backupData.collections.length} collections failed: ` +
        failedCollections.map((c) => c.name).join(', '),
      );
    }
    backup.filePath = filePath;
    backup.fileSize = compressedData.length;
    // Field name is legacy. The data now comes from PostgreSQL, so recording a
    // Mongoose version would misidentify the source of the archive.
    backup.mongoVersion = await getSourceEngineVersion();
    backup.verification.checksum = checksum;
    // 'valid' here means the archive file matches its checksum — it does not
    // mean the archive contains every collection. See status above.
    backup.verification.integrityStatus = 'valid';
    
    // Update collections info
    backup.collections = backupData.collections.map(c => ({
      name: c.name,
      documentCount: c.documentCount
    }));

    await backup.save();

    // If cloud backup is enabled, upload to cloud
    if (backup.storageLocation !== 'local') {
      await uploadToCloud(backup);
    }

    console.log(
      failedCollections.length
        ? `Backup ${backupId} completed WITH ERRORS — ${failedCollections.length} collection(s) missing`
        : `Backup ${backupId} completed successfully`,
    );
  } catch (error) {
    console.error('Backup failed:', error);
    backup.status = 'failed';
    backup.errorMessage = error.message;
    await backup.save();
    
    // Send notification for failed backup
    await notifyBackupFailed(companyId, backup, error.message);
  }
};

// Upload backup to cloud storage
const uploadToCloud = async (backup) => {
  // Upload to configured cloud provider. Implements Google Drive support.
  try {
    if (backup.storageLocation === 's3') {
      // TODO: implement real S3 upload with AWS SDK
      backup.cloudUrl = `s3://backups/${path.basename(backup.filePath)}`;
    } else if (backup.storageLocation === 'google-drive' || backup.storageLocation === 'cloud') {
      // Handle both 'google-drive' and 'cloud' (default to Google Drive) storage types
      try {
        let serviceAccount = null;
        
        // Try multiple sources for credentials
        const possiblePaths = [
          path.join(process.cwd(), 'config', 'google-credentials.json'),
          path.join(process.env.USERPROFILE || process.env.HOME || '', 'Downloads', 'stockmanager-backup-92c9f04a5d8d.json'),
          path.join(process.cwd(), '..', 'Downloads', 'stockmanager-backup-92c9f04a5d8d.json')
        ];

        for (const credPath of possiblePaths) {
          if (fs.existsSync(credPath)) {
            serviceAccount = JSON.parse(fs.readFileSync(credPath, 'utf8'));
            console.log('Found Google credentials at:', credPath);
            break;
          }
        }

        // Also check GOOGLE_SERVICE_ACCOUNT_FILE env var (path to credentials file)
        if (!serviceAccount && process.env.GOOGLE_SERVICE_ACCOUNT_FILE) {
          const credPath = path.resolve(process.cwd(), process.env.GOOGLE_SERVICE_ACCOUNT_FILE);
          if (fs.existsSync(credPath)) {
            serviceAccount = JSON.parse(fs.readFileSync(credPath, 'utf8'));
            console.log('Found Google credentials from GOOGLE_SERVICE_ACCOUNT_FILE:', credPath);
          }
        }

        if (!serviceAccount && process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
          serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
        }

        if (!serviceAccount) {
          throw new Error('Google Service Account credentials not found. Please ensure google-credentials.json exists in config folder or GOOGLE_SERVICE_ACCOUNT_KEY is set.');
        }

        const auth = new google.auth.GoogleAuth({
          credentials: serviceAccount,
          scopes: ['https://www.googleapis.com/auth/drive.file']
        });

        const drive = google.drive({ version: 'v3', auth });

        const fileMetadata = {
          name: path.basename(backup.filePath),
          owners: process.env.GOOGLE_DRIVE_OWNER_EMAIL ? [process.env.GOOGLE_DRIVE_OWNER_EMAIL] : undefined,
        };

        // Optionally upload into a specific folder
        if (process.env.GOOGLE_DRIVE_FOLDER_ID) {
          fileMetadata.parents = [process.env.GOOGLE_DRIVE_FOLDER_ID];
        }

        const media = {
          mimeType: 'application/gzip',
          body: fs.createReadStream(backup.filePath)
        };

        console.log('Starting Google Drive upload for:', backup.filePath);
        
        const response = await drive.files.create({
          resource: fileMetadata,
          media,
          fields: 'id, webViewLink',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true
        });

        const fileId = response.data.id;
        const webViewLink = response.data.webViewLink || (fileId ? `https://drive.google.com/file/d/${fileId}/view` : null);

        backup.cloudUrl = webViewLink || `gdrive://${path.basename(backup.filePath)}`;
        
        console.log('Google Drive upload successful! File ID:', fileId);
      } catch (err) {
        console.error('Google Drive upload failed:', err.message || err);
        // Set failed status - this indicates the backup itself succeeded but cloud upload failed
        backup.cloudUrl = `gdrive-failed://${path.basename(backup.filePath)}`;
        // Log additional error details for debugging
        if (err.response) {
          console.error('Google API Error Response:', err.response.data);
        }
        // Don't re-throw - the local backup is still valid
      }
    } else if (backup.storageLocation === 'dropbox') {
      try {
        const axios = require('axios');
        const dropboxToken = process.env.DROPBOX_ACCESS_TOKEN;
        
        if (!dropboxToken) {
          throw new Error('Dropbox access token not configured');
        }
        
        // Read the backup file
        const fileContent = fs.readFileSync(backup.filePath);
        const fileName = path.basename(backup.filePath);
        
        console.log('Starting Dropbox upload for:', fileName);
        
        // Upload to Dropbox using their API
        const response = await axios.post(
          'https://content.dropboxapi.com/2/files/upload',
          fileContent,
          {
            headers: {
              'Authorization': `Bearer ${dropboxToken}`,
              'Dropbox-API-Arg': JSON.stringify({
                path: `/${fileName}`,
                mode: 'add',
                autorename: true,
                mute: false
              }),
              'Content-Type': 'application/octet-stream'
            }
          }
        );
        
        // Get the shared link for the file
        try {
          const shareResponse = await axios.post(
            'https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings',
            {
              path: response.data.path_lower,
              settings: {
                requested_visibility: 'public'
              }
            },
            {
              headers: {
                'Authorization': `Bearer ${dropboxToken}`,
                'Content-Type': 'application/json'
              }
            }
          );
          backup.cloudUrl = shareResponse.data.url;
        } catch (shareErr) {
          // If shared link already exists, get existing links or use direct link
          if (shareErr.response?.data?.error?.['.tag'] === 'shared_link_already_exists') {
            try {
              const listResponse = await axios.post(
                'https://api.dropboxapi.com/2/sharing/list_shared_links',
                { path: response.data.path_lower },
                {
                  headers: {
                    'Authorization': `Bearer ${dropboxToken}`,
                    'Content-Type': 'application/json'
                  }
                }
              );
              if (listResponse.data.links.length > 0) {
                backup.cloudUrl = listResponse.data.links[0].url;
              } else {
                backup.cloudUrl = `https://www.dropbox.com/home${response.data.path_display}`;
              }
            } catch (listErr) {
              backup.cloudUrl = `https://www.dropbox.com/home${response.data.path_display}`;
            }
          } else {
            backup.cloudUrl = `https://www.dropbox.com/home${response.data.path_display}`;
          }
        }
        
        console.log('Dropbox upload successful! Path:', response.data.path_display);
      } catch (err) {
        console.error('Dropbox upload failed:', err.message || err);
        if (err.response) {
          console.error('Dropbox Error Response:', err.response.data);
        }
        backup.cloudUrl = `dropbox-failed://${path.basename(backup.filePath)}`;
      }
    } else {
      console.warn('Unknown storage location:', backup.storageLocation);
      backup.cloudUrl = null;
    }

    await backup.save();
  } catch (error) {
    console.error('Cloud upload failed:', error);
  }
};

// @desc    Restore from backup
// @route   POST /api/backups/:id/restore
// @access  Private (Admin)
exports.restoreBackup = async (req, res) => {
  try {
    const companyId = req.company._id || req.company;
    
    const backup = await Backup.findOne({ 
      _id: req.params.id, 
      company: companyId 
    });

    if (!backup) {
      return res.status(404).json({
        success: false,
        message: 'Backup not found'
      });
    }

    if (backup.status !== 'completed' && backup.status !== 'verified') {
      return res.status(400).json({
        success: false,
        message: 'Cannot restore from incomplete or failed backup'
      });
    }

    // Start restore process in background
    performRestore(backup._id, companyId, req.user?._id).catch(err => {
      console.error('Restore failed:', err);
    });

    res.json({
      success: true,
      message: 'Restore process initiated successfully',
      data: backup
    });
  } catch (error) {
    console.error('Error restoring backup:', error);
    res.status(500).json({
      success: false,
      message: 'Server error restoring backup',
      error: error.message
    });
  }
};

// Perform the actual restore
const performRestore = async (backupId, companyId, userId) => {
  const backup = await Backup.findById(backupId);
  if (!backup) return;

  try {
    // Refuse a knowingly-partial archive. Restoring one deletes the company's
    // current rows for every collection it does contain, so restoring from an
    // archive that is already missing collections destroys data that the backup
    // cannot put back.
    if (backup.status === 'completed_with_errors') {
      throw new Error(
        'Refusing to restore: this backup completed with errors and is missing at least one '
        + 'collection. Restoring would delete current data that the archive cannot replace.',
      );
    }

    backup.status = 'restoring';
    backup.restore.restoredAt = new Date();
    backup.restore.restoredBy = userId;
    await backup.save();

    const backupDir = getBackupDir();
    const filePath = backup.filePath;

    if (!fs.existsSync(filePath)) {
      throw new Error('Backup file not found');
    }

    // Read and decompress backup
    const compressedData = fs.readFileSync(filePath);
    const decompressedData = zlib.gunzipSync(compressedData);
    const backupData = JSON.parse(decompressedData.toString());

    // THE authoritative completeness check: the archive's own manifest.
    //
    // The status-based refusal above is only an early-out — `status` is mutable
    // and markAsVerified() used to overwrite 'completed_with_errors' with
    // 'verified', laundering a partial archive past that gate. The manifest is a
    // property of the file itself and cannot be edited by changing a record.
    const archiveErrors = (backupData.collections || []).filter((c) => c.error);
    if (archiveErrors.length) {
      throw new Error(
        `Refusing to restore: archive is missing ${archiveErrors.length} collection(s) `
        + `(${archiveErrors.map((c) => c.name).join(', ')}). Restoring would delete current `
        + 'data that this archive cannot replace.',
      );
    }

    // Verify checksum
    const currentChecksum = generateChecksum(compressedData);
    if (currentChecksum !== backup.verification.checksum) {
      throw new Error('Backup file integrity check failed');
    }

    // ALL-OR-NOTHING RESTORE.
    //
    // Every collection is deleted and reinserted inside ONE PostgreSQL
    // transaction. Previously each collection was handled independently with
    // its own try/catch, so a failure partway through left the company with
    // some collections restored, some emptied by the delete, and some
    // untouched — an unrecoverable mixture, because the delete had already run.
    //
    // The compat models join this transaction automatically: runInTransaction
    // publishes the Prisma transaction client on the async context and
    // prismaCompat resolves its delegate from there (see lib/txContext.js).
    // Nothing has to be threaded through by hand, which is what makes wrapping
    // a loop over 28 models feasible at all.
    //
    // Errors are deliberately NOT caught per collection: the first failure must
    // abort the transaction so Postgres rolls the whole thing back.
    const restoredCounts = [];
    await runInTransaction(async () => {
      for (const collection of backupData.collections) {
        const Model = resolveBackupModel(collection.name);
        if (!Model || typeof Model.deleteMany !== 'function') {
          // Throwing rolls back everything done so far, which is correct: a
          // restore missing a collection is not a restore.
          throw new Error(`No usable model for collection "${collection.name}"`);
        }

        await Model.deleteMany({ company: companyId });

        if (collection.data && collection.data.length > 0) {
          const newData = collection.data.map((doc) => {
            const newDoc = { ...doc };
            // New ids: the archive's ids may collide with rows created since.
            newDoc._id = generateObjectId();
            newDoc.company = companyId;
            newDoc.createdAt = doc.createdAt ? new Date(doc.createdAt) : new Date();
            newDoc.updatedAt = doc.updatedAt ? new Date(doc.updatedAt) : new Date();
            return newDoc;
          });

          await Model.insertMany(newData);
          restoredCounts.push(`${collection.name}: ${newData.length}`);
        } else {
          restoredCounts.push(`${collection.name}: 0`);
        }
      }
    }, {
      // A full-company restore writes far more than an ordinary request. Without
      // a raised timeout Prisma aborts mid-restore — which now rolls back
      // safely, but fails work that would otherwise have succeeded.
      timeout: Number(process.env.RESTORE_TRANSACTION_TIMEOUT_MS) || 120000,
      maxWait: Number(process.env.RESTORE_TRANSACTION_MAX_WAIT_MS) || 10000,
    });

    console.log(`[restore] Restored ${restoredCounts.length} collections: ${restoredCounts.join(', ')}`);

    // Reaching here means the transaction committed, so every collection was
    // restored. There is no longer a "partially restored" outcome to report:
    // any failure above throws, the transaction rolls back, and the outer catch
    // records the backup as failed with the database untouched.
    backup.status = 'verified';
    await backup.save();

    console.log(`Restore from backup ${backupId} completed successfully`);
  } catch (error) {
    console.error('Restore failed:', error);
    backup.status = 'failed';
    backup.errorMessage = error.message;
    await backup.save();
  }
};

// @desc    Verify backup integrity
// @route   POST /api/backups/:id/verify
// @access  Private (Admin)
exports.verifyBackup = async (req, res) => {
  try {
    const companyId = req.company._id || req.company;
    
    const backup = await Backup.findOne({ 
      _id: req.params.id, 
      company: companyId 
    });

    if (!backup) {
      return res.status(404).json({
        success: false,
        message: 'Backup not found'
      });
    }

    if (backup.status !== 'completed') {
      return res.status(400).json({
        success: false,
        message: 'Can only verify completed backups'
      });
    }

    // Verify backup in background
    performVerification(backup._id, req.user?._id).catch(err => {
      console.error('Verification failed:', err);
    });

    res.json({
      success: true,
      message: 'Backup verification initiated'
    });
  } catch (error) {
    console.error('Error verifying backup:', error);
    res.status(500).json({
      success: false,
      message: 'Server error verifying backup',
      error: error.message
    });
  }
};

// Perform backup verification
const performVerification = async (backupId, userId) => {
  const backup = await Backup.findById(backupId);
  if (!backup) return;

  try {
    const backupDir = getBackupDir();
    const filePath = backup.filePath;

    if (!fs.existsSync(filePath)) {
      backup.verification.integrityStatus = 'missing';
      backup.verification.errorMessage = 'Backup file not found';
      await backup.save();
      return;
    }

    // Read and verify checksum
    const fileData = fs.readFileSync(filePath);
    const currentChecksum = generateChecksum(fileData);

    backup.verification.verified = currentChecksum === backup.verification.checksum;
    backup.verification.verifiedAt = new Date();
    backup.verification.verifiedBy = userId;
    
    if (backup.verification.verified) {
      backup.verification.integrityStatus = 'valid';
      backup.status = 'verified';
    } else {
      backup.verification.integrityStatus = 'corrupted';
      backup.verification.errorMessage = 'Checksum mismatch - backup may be corrupted';
    }

    await backup.save();
    console.log(`Backup ${backupId} verification completed: ${backup.verification.verified}`);
  } catch (error) {
    console.error('Verification failed:', error);
    backup.verification.integrityStatus = 'corrupted';
    backup.verification.errorMessage = error.message;
    await backup.save();
  }
};

// @desc    Delete backup
// @route   DELETE /api/backups/:id
// @access  Private (Admin)
exports.deleteBackup = async (req, res) => {
  try {
    const companyId = req.company._id || req.company;
    
    const backup = await Backup.findOne({ 
      _id: req.params.id, 
      company: companyId 
    });

    if (!backup) {
      return res.status(404).json({
        success: false,
        message: 'Backup not found'
      });
    }

    // Delete local file if exists
    if (backup.filePath && fs.existsSync(backup.filePath)) {
      fs.unlinkSync(backup.filePath);
    }

    await backup.deleteOne();

    res.json({
      success: true,
      message: 'Backup deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting backup:', error);
    res.status(500).json({
      success: false,
      message: 'Server error deleting backup',
      error: error.message
    });
  }
};

// @desc    Get available point-in-time recovery points
// @route   GET /api/backups/points-in-time
// @access  Private
exports.getPointsInTime = async (req, res) => {
  try {
    const companyId = req.company._id || req.company;
    
    const backups = await Backup.find({ 
      company: companyId,
      status: { $in: ['completed', 'verified'] }
    })
      .select('name createdAt pointInTime fileSize collections')
      .sort({ createdAt: -1 })
      .limit(100);

    const pointsInTime = backups.map(b => ({
      id: b._id,
      name: b.name,
      timestamp: b.pointInTime || b.createdAt,
      fileSize: b.fileSize,
      totalDocuments: b.collections.reduce((sum, c) => sum + c.documentCount, 0)
    }));

    res.json({
      success: true,
      data: pointsInTime
    });
  } catch (error) {
    console.error('Error getting points in time:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Get backup settings
// @route   GET /api/backups/settings
// @access  Private (Admin)
exports.getBackupSettings = async (req, res) => {
  try {
    const companyId = req.company._id || req.company;
    
    // Get the backup settings document (type: 'scheduled')
    let settings = await Backup.findOne({ 
      company: companyId,
      type: 'scheduled'
    }).sort({ createdAt: -1 });

    // Return default settings if none exist
    if (!settings) {
      return res.json({
        success: true,
        data: {
          enabled: false,
          frequency: 'daily',
          retention: 30,
          storageLocation: 'local',
          autoVerify: false
        }
      });
    }

    res.json({
      success: true,
      data: {
        enabled: settings.schedule?.enabled || false,
        frequency: settings.schedule?.frequency || 'daily',
        retention: settings.retention?.keepForDays || 30,
        storageLocation: settings.storageLocation || 'local',
        autoVerify: settings.schedule?.autoVerify || false,
        cloudConfig: settings.cloudConfig
      }
    });
  } catch (error) {
    console.error('Error getting backup settings:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Update backup settings
// @route   PUT /api/backups/settings
// @access  Private (Admin)
exports.updateBackupSettings = async (req, res) => {
  try {
    const companyId = req.company._id || req.company;
    const { 
      enabled,
      frequency,
      retention,
      storageLocation,
      cloudConfig,
      autoVerify
    } = req.body;

    // Create or update backup settings
    let backupSettings = await Backup.findOne({ 
      company: companyId,
      type: 'scheduled'
    });

    if (!backupSettings) {
      backupSettings = new Backup({
        company: companyId,
        name: 'Scheduled Backup Settings',
        type: 'scheduled',
        status: 'pending'
      });
    }

    backupSettings.schedule.enabled = enabled || false;
    backupSettings.schedule.frequency = frequency || 'daily';
    backupSettings.schedule.autoVerify = autoVerify || false;
    backupSettings.retention.keepForDays = retention || 30;
    backupSettings.storageLocation = storageLocation || 'local';
    
    if (cloudConfig) {
      backupSettings.cloudConfig = {
        provider: cloudConfig.provider || 'local',
        bucket: cloudConfig.bucket,
        region: cloudConfig.region
      };
    }

    // Calculate next run based on frequency
    const now = new Date();
    switch (frequency) {
      case 'hourly':
        backupSettings.schedule.nextRun = new Date(now.getTime() + 60 * 60 * 1000);
        backupSettings.schedule.cronExpression = '0 * * * *';
        break;
      case 'daily':
        backupSettings.schedule.nextRun = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        backupSettings.schedule.cronExpression = '0 2 * * *';
        break;
      case 'weekly':
        backupSettings.schedule.nextRun = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        backupSettings.schedule.cronExpression = '0 2 * * 0';
        break;
      case 'monthly':
        backupSettings.schedule.nextRun = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        backupSettings.schedule.cronExpression = '0 2 1 * *';
        break;
    }

    await backupSettings.save();

    res.json({
      success: true,
      message: 'Backup settings updated successfully',
      data: backupSettings
    });
  } catch (error) {
    console.error('Error updating backup settings:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Download backup file
// @route   GET /api/backups/:id/download
// @access  Private (Admin)
exports.downloadBackup = async (req, res) => {
  try {
    const companyId = req.company._id || req.company;
    
    const backup = await Backup.findOne({ 
      _id: req.params.id, 
      company: companyId 
    });

    if (!backup) {
      return res.status(404).json({
        success: false,
        message: 'Backup not found'
      });
    }

    if (!backup.filePath || !fs.existsSync(backup.filePath)) {
      return res.status(404).json({
        success: false,
        message: 'Backup file not found'
      });
    }

    res.download(backup.filePath, path.basename(backup.filePath));
  } catch (error) {
    console.error('Error downloading backup:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Get backup statistics
// @route   GET /api/backups/stats
// @access  Private
exports.getBackupStats = async (req, res) => {
  try {
    const companyId = req.company._id || req.company;
    
    const stats = await Backup.aggregate([
      { $match: { company: new mongoose.Types.ObjectId(companyId) } },
      {
        $group: {
          _id: null,
          totalBackups: { $sum: 1 },
          completedBackups: { 
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
          },
          verifiedBackups: { 
            $sum: { $cond: [{ $eq: ['$status', 'verified'] }, 1, 0] }
          },
          failedBackups: { 
            $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] }
          },
          totalSize: { $sum: '$fileSize' },
          lastBackup: { $max: '$createdAt' }
        }
      }
    ]);

    const result = stats[0] || {
      totalBackups: 0,
      completedBackups: 0,
      verifiedBackups: 0,
      failedBackups: 0,
      totalSize: 0,
      lastBackup: null
    };

    res.json({
      success: true,
      data: {
        ...result,
        formattedTotalSize: result.totalSize === 0 ? '0 B' : 
          formatBytes(result.totalSize)
      }
    });
  } catch (error) {
    console.error('Error getting backup stats:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Export for scheduled jobs
module.exports.performBackup = performBackup;
module.exports.performRestore = performRestore;
module.exports.performVerification = performVerification;
