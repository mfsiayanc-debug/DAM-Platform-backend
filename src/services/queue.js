const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const config = require('../config');

// Create Redis connection
const connection = new IORedis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: null,
});

// Create queue
const assetQueue = new Queue(config.queue.name, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: {
      count: 100,
      age: 3600, // Keep completed jobs for 1 hour
    },
    removeOnFail: {
      count: 50,
    },
  },
});

// Add job to queue
async function addJob(jobName, data, options = {}) {
  try {
    const job = await assetQueue.add(jobName, data, options);
    console.log(`Job ${jobName} added to queue:`, job.id);
    return job;
  } catch (error) {
    console.error('Failed to add job to queue:', error);
    throw error;
  }
}

// Get queue metrics
async function getQueueMetrics() {
  const [waiting, active, completed, failed] = await Promise.all([
    assetQueue.getWaitingCount(),
    assetQueue.getActiveCount(),
    assetQueue.getCompletedCount(),
    assetQueue.getFailedCount(),
  ]);

  return {
    waiting,
    active,
    completed,
    failed,
    total: waiting + active + completed + failed,
  };
}

module.exports = {
  assetQueue,
  addJob,
  getQueueMetrics,
  connection,
};
