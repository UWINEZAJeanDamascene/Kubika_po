const { Queue, Worker, QueueEvents } = require('bullmq');
const { isRedisConfigured, createQueueConnection } = require('../config/redis');
const ImportLog = require('../models/ImportLog');
const { processValidatedRows } = require('./universalImportService');

const QUEUE_NAME = 'import-processing';
const memoryJobs = new Map();
let queue = null;
let worker = null;
let queueEvents = null;
const activeByCompany = new Map();
const waitingByCompany = new Map();

async function runWithTenantLimit(companyId, task) {
  const key = String(companyId);
  while ((activeByCompany.get(key) || 0) >= 2) {
    await new Promise((resolve) => {
      const waiters = waitingByCompany.get(key) || [];
      waiters.push(resolve);
      waitingByCompany.set(key, waiters);
    });
  }
  activeByCompany.set(key, (activeByCompany.get(key) || 0) + 1);
  try {
    return await task();
  } finally {
    activeByCompany.set(key, Math.max(0, (activeByCompany.get(key) || 1) - 1));
    const waiters = waitingByCompany.get(key) || [];
    const next = waiters.shift();
    if (waiters.length) waitingByCompany.set(key, waiters);
    else waitingByCompany.delete(key);
    if (next) next();
  }
}

function createBullConnection() {
  return createQueueConnection();
}

function ensureBull() {
  if (!isRedisConfigured()) return null;
  if (queue) return queue;
  const connection = createBullConnection();
  if (!connection) return null;
  queue = new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100
    }
  });
  queueEvents = new QueueEvents(QUEUE_NAME, { connection });
  worker = new Worker(QUEUE_NAME, async (job) => {
    const payload = job.data;
    return runWithTenantLimit(payload.companyId, () => {
      return processValidatedRows({
        ...payload,
        onProgress: async (processed, total) => {
          await job.updateProgress({ processed, total, percent: Math.round((processed / total) * 100) });
        }
      });
    });
  }, {
    connection,
    concurrency: 8
  });
  worker.on('failed', async (job, error) => {
    if (job?.data?.logId) {
      await ImportLog.updateOne({ _id: job.data.logId, companyId: job.data.companyId }, {
        $set: { status: 'failed', completedAt: new Date(), errorMessage: error.message }
      });
    }
  });
  return queue;
}

async function enqueueImport(payload) {
  const bull = ensureBull();
  if (bull) {
    const job = await bull.add('process-import', payload, { jobId: String(payload.logId) });
    await ImportLog.updateOne({ _id: payload.logId, companyId: payload.companyId }, { $set: { jobId: job.id } });
    return { jobId: job.id, backend: 'bullmq' };
  }

  const jobId = String(payload.logId);
  memoryJobs.set(jobId, { id: jobId, status: 'waiting', progress: { processed: 0, total: payload.rows.length, percent: 0 }, result: null });
  await ImportLog.updateOne({ _id: payload.logId, companyId: payload.companyId }, { $set: { jobId } });
  setImmediate(async () => {
    const memoryJob = memoryJobs.get(jobId);
    if (!memoryJob) return;
    memoryJob.status = 'active';
    try {
      memoryJob.result = await processValidatedRows({
        ...payload,
        onProgress: async (processed, total) => {
          memoryJob.progress = { processed, total, percent: Math.round((processed / total) * 100) };
        }
      });
      memoryJob.status = 'completed';
    } catch (error) {
      memoryJob.status = 'failed';
      memoryJob.error = error.message;
      await ImportLog.updateOne({ _id: payload.logId, companyId: payload.companyId }, {
        $set: { status: 'failed', completedAt: new Date(), errorMessage: error.message }
      });
    }
  });
  return { jobId, backend: 'memory-fallback' };
}

async function getProgress(jobId, companyId) {
  const bull = ensureBull();
  if (bull) {
    const job = await bull.getJob(jobId);
    if (job) {
      const log = await ImportLog.findOne({ jobId, companyId }).lean();
      const state = await job.getState();
      return {
        jobId,
        status: log?.status || state,
        progress: job.progress || { processed: 0, total: log?.totalRows || 0, percent: 0 },
        result: log
      };
    }
  }

  const memoryJob = memoryJobs.get(jobId);
  const log = await ImportLog.findOne({ jobId, companyId }).lean();
  if (!memoryJob && !log) return null;
  return {
    jobId,
    status: log?.status || memoryJob?.status || 'pending',
    progress: memoryJob?.progress || { processed: log?.successRows || 0, total: log?.totalRows || 0, percent: log?.status?.startsWith('completed') ? 100 : 0 },
    result: log
  };
}

async function markInterruptedMemoryJobs() {
  if (isRedisConfigured()) return { skipped: true, reason: 'redis-configured' };
  const result = await ImportLog.updateMany(
    { status: { $in: ['pending', 'processing'] }, jobId: { $ne: null } },
    {
      $set: {
        status: 'failed',
        completedAt: new Date(),
        errorMessage: 'Import interrupted because the server restarted while Redis/BullMQ was unavailable. Memory fallback jobs are not durable.'
      }
    }
  );
  return { skipped: false, modifiedCount: result.modifiedCount || 0 };
}

module.exports = {
  enqueueImport,
  getProgress,
  markInterruptedMemoryJobs,
  QUEUE_NAME
};
