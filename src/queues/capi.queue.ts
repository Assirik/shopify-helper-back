import { JobsOptions, Queue } from 'bullmq';
import { getRedisConnection } from './notification.queue';

export const CAPI_PURCHASE_QUEUE_NAME = 'capi-purchase';
export const SEND_CAPI_PURCHASE_JOB = 'sendCapiPurchase';

export interface CapiPurchaseJobData {
  orderId: string;
}

// Deterministic id: replaying a trigger never enqueues a second Purchase for the same order.
// BullMQ rejects custom ids containing ':' ("Custom Id cannot contain :"), hence the dash.
export const buildCapiPurchaseJobId = (orderId: string) => `capi-purchase-${orderId}`;

export const capiPurchaseQueue = new Queue<CapiPurchaseJobData>(CAPI_PURCHASE_QUEUE_NAME, {
  connection: getRedisConnection()
});

// 5 attempts with exponential backoff: 1 min, 2 min, 4 min, 8 min between tries.
export const capiPurchaseJobOptions: JobsOptions = {
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 60_000
  },
  removeOnComplete: 500,
  removeOnFail: 1000
};

// A finished job (completed or failed) keeps its id while retained, and BullMQ silently ignores
// an add with an existing id: remove it first so the order can be enqueued again. A job still
// waiting, delayed or active is reused (no duplicate). The worker guards (SENT → exit, writes
// conditioned on PENDING) prevent a second Purchase.
export const enqueueCapiPurchase = async (orderId: string) => {
  const jobId = buildCapiPurchaseJobId(orderId);
  const existing = await capiPurchaseQueue.getJob(jobId);

  if (existing) {
    const state = await existing.getState();

    if (state !== 'completed' && state !== 'failed' && state !== 'unknown') {
      return existing;
    }

    if (state === 'completed' || state === 'failed') {
      await existing.remove();
    }
  }

  return capiPurchaseQueue.add(SEND_CAPI_PURCHASE_JOB, { orderId }, { ...capiPurchaseJobOptions, jobId });
};
