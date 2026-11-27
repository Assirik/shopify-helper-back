import { Types } from 'mongoose';
import { CapiPurchaseStatus, CapiSkipReason, IOrder, Order } from '../../models/Order';
import { OrderEvent, OrderEventType } from '../../models/OrderEvent';
import { enqueueCapiPurchaseWithOutcome } from '../../queues/capi.queue';
import { withTimeout } from '../../queues/queueTimeout';
import log from '../logger/logger';
import { capiDedupWindowStart, getCapiResendRejection } from './orderCapabilities.service';

export type CapiPurchaseTrigger = 'confirmation' | 'delivery';

// A pending order untouched for this long is considered lost (enqueue failed or job gone).
export const CAPI_PURCHASE_SWEEP_STALE_MS = 15 * 60 * 1000;
export const CAPI_PURCHASE_SWEEP_BATCH_SIZE = 200;

// BullMQ refuses to remove a job held by a worker: an active job is already processing the
// order, so there is nothing to enqueue.
const isLockedJobError = (err: unknown) =>
  err instanceof Error && /could not be removed because it is locked/i.test(err.message);

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Fields describing the previous outcome, removed whenever the Purchase goes back to PENDING.
const BACK_TO_PENDING_UNSET = {
  capiSkipReason: '',
  capiPurchaseError: '',
  capiPurchaseFailedAt: '',
  capiPurchaseFailureDefinitive: ''
};

// A job still waiting, delayed or active is kept, never doubled (two jobs could both call
// Meta): when it was already past its PENDING check, the order waits for the sweep.
const logEnqueueOutcome = (
  context: Record<string, unknown>,
  outcome: { reused: boolean; state?: string }
) => {
  if (outcome.reused) {
    log.info({ ...context, jobState: outcome.state }, 'CAPI purchase job reused, nothing enqueued');
    return;
  }

  log.info(context, 'CAPI purchase enqueued');
};

// Nothing was reserved: says so when the reason is an attempt that may have reached Meta too
// long ago (the usual case, a Purchase already handled, stays silent). Never throws.
const logMissedTakeBack = async (id: string, trigger: CapiPurchaseTrigger, windowStart: Date) => {
  try {
    const current = await Order.findById(id);
    const possiblyReceivedAt = current?.capiPossiblyReceivedAt;

    if (
      current?.capiPurchaseStatus === CapiPurchaseStatus.SKIPPED &&
      current.capiSkipReason === CapiSkipReason.CANCELLED &&
      possiblyReceivedAt &&
      new Date(possiblyReceivedAt).getTime() <= windowStart.getTime()
    ) {
      log.warn(
        { orderId: id, trigger, capiPossiblyReceivedAt: possiblyReceivedAt },
        'CAPI purchase skipped as cancelled not taken back: Meta may have received it 47 h or more ago'
      );
    }
  } catch (err) {
    log.error({ orderId: id, trigger, error: errorMessage(err) }, 'Failed to read the order after a missed CAPI take-back');
  }
};

/**
 * Marks the order's Purchase as PENDING and enqueues it, once per order whatever the path
 * (confirmation, then delivery as a fallback): the write only applies while the status is
 * absent, or SKIPPED as `cancelled` (the order was not a sale when the worker ran, and has
 * been confirmed or delivered since: second chance; the worker applies its rules again),
 * unless an earlier attempt may have reached Meta 47 h or more ago (`capiPossiblyReceivedAt`:
 * Meta would no longer deduplicate it). No other status or skip reason is taken back
 * automatically. Fire-and-forget: callers do not await it and it never throws. When the
 * enqueue fails the order stays PENDING (never unset) and the sweep re-enqueues it. With
 * Redis down the enqueue may never settle: the confirmation or delivery has already answered.
 */
export const triggerCapiPurchase = async (
  orderId: string | Types.ObjectId,
  trigger: CapiPurchaseTrigger
): Promise<void> => {
  const id = orderId.toString();
  const windowStart = capiDedupWindowStart();
  let claimed;

  try {
    claimed = await Order.findOneAndUpdate(
      {
        _id: id,
        $or: [
          { capiPurchaseStatus: { $exists: false } },
          {
            capiPurchaseStatus: CapiPurchaseStatus.SKIPPED,
            capiSkipReason: CapiSkipReason.CANCELLED,
            $or: [{ capiPossiblyReceivedAt: null }, { capiPossiblyReceivedAt: { $gt: windowStart } }]
          }
        ]
      },
      {
        $set: { capiPurchaseStatus: CapiPurchaseStatus.PENDING },
        $unset: BACK_TO_PENDING_UNSET
      },
      { new: true }
    );
  } catch (err) {
    log.error({ orderId: id, trigger, error: errorMessage(err) }, 'Failed to mark CAPI purchase as pending');
    return;
  }

  if (!claimed) {
    await logMissedTakeBack(id, trigger, windowStart);
    return;
  }

  try {
    logEnqueueOutcome({ orderId: id, trigger }, await enqueueCapiPurchaseWithOutcome(id));
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

export class CapiPurchaseResendError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = 'CapiPurchaseResendError';
    this.code = code;
    this.status = status;
  }
}

const toActorObjectId = (actorId?: string) =>
  actorId && Types.ObjectId.isValid(actorId) ? new Types.ObjectId(actorId) : undefined;

/**
 * Admin resend of a Purchase that failed, was skipped as `disabled`, or was skipped as
 * `cancelled` by an order that has since become a sale (eligibility: `getCapiResendRejection`).
 * The write back to PENDING is conditioned on the status, skip reason, failure date and
 * possibly-received mark just read: a concurrent change or a double click gets a 409 and
 * nothing is enqueued. The mark is never cleared. The enqueue is bounded and never fails the request: the order stays
 * PENDING and the sweep re-enqueues it.
 */
export const resendCapiPurchase = async (orderId: string, actorId?: string): Promise<IOrder> => {
  if (!Types.ObjectId.isValid(orderId)) {
    throw new CapiPurchaseResendError('OrderNotFound', 'Order not found', 404);
  }

  const order = await Order.findById(orderId);

  if (!order) {
    throw new CapiPurchaseResendError('OrderNotFound', 'Order not found', 404);
  }

  const rejection = getCapiResendRejection(order);

  if (rejection) {
    throw new CapiPurchaseResendError(rejection, `CAPI purchase cannot be resent (${rejection})`);
  }

  const previousStatus = order.capiPurchaseStatus as CapiPurchaseStatus;
  const previousSkipReason = previousStatus === CapiPurchaseStatus.SKIPPED ? order.capiSkipReason : undefined;
  // FAILED: also conditioned on the failure that was judged resendable (date read).
  const previousFailure =
    previousStatus === CapiPurchaseStatus.FAILED ? { capiPurchaseFailedAt: order.capiPurchaseFailedAt ?? null } : {};
  const updated = await Order.findOneAndUpdate(
    {
      _id: order._id,
      capiPurchaseStatus: previousStatus,
      ...(previousSkipReason ? { capiSkipReason: previousSkipReason } : {}),
      ...previousFailure,
      // An attempt that reached Meta since the read must not be resent on the old judgement.
      capiPossiblyReceivedAt: order.capiPossiblyReceivedAt ?? null
    },
    {
      $set: { capiPurchaseStatus: CapiPurchaseStatus.PENDING },
      $unset: BACK_TO_PENDING_UNSET
    },
    { new: true }
  );

  if (!updated) {
    throw new CapiPurchaseResendError(
      'CapiPurchaseNotResendable',
      'CAPI purchase status changed concurrently, nothing resent'
    );
  }

  const id = updated._id.toString();

  try {
    logEnqueueOutcome(
      { orderId: id, actorId, previousStatus, previousSkipReason },
      await withTimeout(enqueueCapiPurchaseWithOutcome(id))
    );
  } catch (err) {
    if (isLockedJobError(err)) {
      log.info({ orderId: id }, 'CAPI purchase job already active, nothing to enqueue');
    } else {
      log.error(
        { orderId: id, error: errorMessage(err) },
        'Failed to enqueue CAPI purchase resend, left pending for the sweep'
      );
    }
  }

  // The resend is already effective (PENDING, job queued or left to the sweep): a missing
  // history entry is logged, it does not fail the request.
  try {
    await OrderEvent.create({
      orderId: updated._id,
      type: OrderEventType.CAPI_PURCHASE_RESEND_REQUESTED,
      actorId: toActorObjectId(actorId),
      metadata: {
        previousStatus,
        ...(previousSkipReason ? { previousSkipReason } : {})
      }
    });
  } catch (err) {
    log.error({ orderId: id, actorId, error: errorMessage(err) }, 'Failed to record CAPI purchase resend event');
  }

  return updated;
};

/**
 * Catch-up sweep: re-enqueues orders still PENDING with no write for 15 min. `updatedAt`
 * (Mongoose timestamps, bumped by every write) is used rather than a dedicated field: an
 * unrelated write on the order only postpones the catch-up, it never hides or duplicates
 * it, and `enqueueCapiPurchaseWithOutcome` reuses a job still waiting, delayed or active.
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
