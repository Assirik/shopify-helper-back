import { Job, Worker } from 'bullmq';
import { CAPI_PURCHASE_SWEEP_JOB, CAPI_PURCHASE_SWEEP_QUEUE_NAME } from '../queues/capi.queue';
import { getRedisConnection } from '../queues/notification.queue';
import log from '../utilities/logger/logger';
import { runCapiPurchaseSweep } from '../utilities/services/capiPurchase.service';

let capiPurchaseSweepWorker: Worker | null = null;

// Per-order enqueue errors are caught and counted by the sweep itself: only an unexpected
// job name or an infrastructure error (MongoDB read) fails the job, and the next tick retries.
export const processCapiPurchaseSweepJob = async (job: Job) => {
  if (job.name !== CAPI_PURCHASE_SWEEP_JOB) {
    throw new Error(`Unsupported CAPI purchase sweep job: ${job.name}`);
  }

  return runCapiPurchaseSweep();
};

export const startCapiPurchaseSweepWorker = () => {
  if (capiPurchaseSweepWorker) {
    return capiPurchaseSweepWorker;
  }

  capiPurchaseSweepWorker = new Worker(CAPI_PURCHASE_SWEEP_QUEUE_NAME, processCapiPurchaseSweepJob, {
    connection: getRedisConnection()
  });

  capiPurchaseSweepWorker.on('failed', (job, err) => {
    log.error({ err, jobId: job?.id }, 'CAPI purchase sweep job failed');
  });

  capiPurchaseSweepWorker.on('error', err => {
    log.error({ err }, 'CAPI purchase sweep worker error');
  });

  log.info({ queueName: CAPI_PURCHASE_SWEEP_QUEUE_NAME }, 'CAPI purchase sweep worker started');

  return capiPurchaseSweepWorker;
};

export const stopCapiPurchaseSweepWorker = async () => {
  if (!capiPurchaseSweepWorker) {
    return;
  }

  await capiPurchaseSweepWorker.close();
  capiPurchaseSweepWorker = null;
  log.info({ queueName: CAPI_PURCHASE_SWEEP_QUEUE_NAME }, 'CAPI purchase sweep worker stopped');
};
