import { Types } from 'mongoose';
import { CapiPurchaseStatus, Order } from '../../models/Order';
import { enqueueCapiPurchase, enqueueCapiPurchaseWithOutcome } from '../../queues/capi.queue';
import log from '../logger/logger';

export type CapiPurchaseTrigger = 'confirmation' | 'delivery';

// A pending order untouched for this long is considered lost (enqueue failed or job gone).
export const CAPI_PURCHASE_SWEEP_STALE_MS = 15 * 60 * 1000;
export const CAPI_PURCHASE_SWEEP_BATCH_SIZE = 200;

// BullMQ refuses to remove a job held by a worker: an active job is already processing the
// order, so there is nothing to enqueue.
const isLockedJobError = (err: unknown) =>
  err instanceof Error && /could not be removed because it is locked/i.test(err.message);

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Marks the order's Purchase as PENDING and enqueues it, once per order whatever the path
 * (confirmation, then delivery as a fallback): the write only applies while the status is
 * absent. Fire-and-forget: callers do not await it and it never throws. When the enqueue
 * fails the order stays PENDING (never unset) and the sweep re-enqueues it. With Redis down
 * the enqueue may never settle: the confirmation or delivery has already answered.
 */
export const triggerCapiPurchase = async (
  orderId: string | Types.ObjectId,
  trigger: CapiPurchaseTrigger
): Promise<void> => {
  const id = orderId.toString();
  let claimed;

  try {
    claimed = await Order.findOneAndUpdate(
      { _id: id, capiPurchaseStatus: { $exists: false } },
      { $set: { capiPurchaseStatus: CapiPurchaseStatus.PENDING } },
      { new: true }
    );
  } catch (err) {
    log.error({ orderId: id, trigger, error: errorMessage(err) }, 'Failed to mark CAPI purchase as pending');
    return;
  }

  if (!claimed) {
    return;
  }

  try {
    await enqueueCapiPurchase(id);
    log.info({ orderId: id, trigger }, 'CAPI purchase enqueued');
  } catch (err) {
    if (isLockedJobError(err)) {
      log.info({ orderId: id, trigger }, 'CAPI purchase job already active, nothing to enqueue');
      return;
    }

    log.error(
      { orderId: id, trigger, error: errorMessage(err) },
      'Failed to enqueue CAPI purchase, left pending for the sweep'
    );
  }
};

/**
 * Catch-up sweep: re-enqueues orders still PENDING with no write for 15 min. `updatedAt`
 * (Mongoose timestamps, bumped by every write) is used rather than a dedicated field: an
 * unrelated write on the order only postpones the catch-up, it never hides or duplicates
 * it, and `enqueueCapiPurchase` reuses a job still waiting, delayed or active.
 */
export const runCapiPurchaseSweep = async (now: Date = new Date()) => {
  const candidates = await Order.find({
    capiPurchaseStatus: CapiPurchaseStatus.PENDING,
    updatedAt: { $lte: new Date(now.getTime() - CAPI_PURCHASE_SWEEP_STALE_MS) }
  })
    .select('_id')
    .sort({ updatedAt: 1 })
    .limit(CAPI_PURCHASE_SWEEP_BATCH_SIZE);

  // `enqueued`: a job was added. `alreadyQueued`: a job still waiting, delayed or active
  // (retries in progress) was kept, or a locked one is being processed: nothing re-enqueued.
  let enqueued = 0;
  let alreadyQueued = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const id = candidate._id.toString();

    try {
      const { reused } = await enqueueCapiPurchaseWithOutcome(id);

      if (reused) {
        alreadyQueued += 1;
      } else {
        enqueued += 1;
      }
    } catch (err) {
      if (isLockedJobError(err)) {
        alreadyQueued += 1;
        continue;
      }

      failed += 1;
      log.error({ orderId: id, error: errorMessage(err) }, 'CAPI purchase sweep failed to enqueue order');
    }
  }

  if (candidates.length) {
    log.info({ candidates: candidates.length, enqueued, alreadyQueued, failed }, 'CAPI purchase sweep completed');
  }

  return { candidates: candidates.length, enqueued, alreadyQueued, failed };
};
