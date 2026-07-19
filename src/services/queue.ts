import IORedis from 'ioredis';
import { JobsOptions, Queue } from 'bullmq';
import config from '../config';

const connection = new IORedis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: null,
});

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
      age: 3600,
    },
    removeOnFail: {
      count: 50,
    },
  },
});

async function addJob(jobName: string, data: Record<string, unknown>, options: JobsOptions = {}) {
  try {
    const job = await assetQueue.add(jobName, data, options);
    console.log(`Job ${jobName} added to queue:`, job.id);
    return job;
  } catch (error) {
    console.error('Failed to add job to queue:', error);
    throw error;
  }
}

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

export { assetQueue, addJob, getQueueMetrics, connection };
