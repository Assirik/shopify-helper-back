import { Job, UnrecoverableError, Worker } from 'bullmq';
import { CapiPurchaseStatus, CustomerConfirmationStatus, IOrder, Order } from '../models/Order';
import { OrderEvent, OrderEventType } from '../models/OrderEvent';
import { CapiSendResult, MetaCapiError, buildFbc, sendPurchase } from '../providers/metaCapi.provider';
import { CAPI_PURCHASE_QUEUE_NAME, CapiPurchaseJobData } from '../queues/capi.queue';
import { getRedisConnection } from '../queues/notification.queue';
import config from '../utilities/config/env.config';
import log from '../utilities/logger/logger';

export type CapiSkipReason = 'test' | 'cancelled' | 'disabled' | 'too_old';

// Meta rejects events older than 7 days; keep a 1 h margin for queue and network delays.
export const CAPI_MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000;

const MAX_ERROR_LENGTH = 300;

let capiPurchaseWorker: Worker<CapiPurchaseJobData> | null = null;

// Meta documents the 7-day limit but no error code for it. Code 100 / subcode 2804003 comes
// from public reports (not from Meta's documentation); the user-facing texts ("Event Timestamp
// Too Old", "The timestamp for this event is too far in the past") are matched as a fallback.
const TOO_OLD_META_CODE = 100;
const TOO_OLD_META_SUBCODE = 2804003;
const TOO_OLD_TEXT = /too far in the past|too old/i;

export const isTooOldRejection = (err: unknown): boolean => {
  if (!(err instanceof MetaCapiError) || err.retryable) {
    return false;
  }

  if (err.metaCode === TOO_OLD_META_CODE && err.metaSubcode === TOO_OLD_META_SUBCODE) {
    return true;
  }

  return [err.metaUserTitle, err.metaUserMessage, err.message].some(text => Boolean(text) && TOO_OLD_TEXT.test(text as string));
};

// Short, token-free error text stored on the order and in the event.
export const toShortErrorMessage = (err: unknown): string => {
  let message = err instanceof Error ? err.message : String(err);
  const token = config.metaCapi.accessToken;

  if (token) {
    message = message.split(token).join('[redacted]');
  }

  message = message.replace(/access_token=[^\s&"']+/gi, 'access_token=[redacted]');

  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 1)}…` : message;
};

export const getSkipReason = (order: IOrder, now: Date = new Date()): CapiSkipReason | undefined => {
  if (order.isTest) {
    return 'test';
  }

  if (order.shopifyCancelledAt) {
    return 'cancelled';
  }

  // Cancelled by an agent while the send was delayed (Meta 5xx, Redis) before the retry.
  // A delivered order is a real sale even if it was cancelled on the way (cancelByAdmin
  // leaves operationalStatus untouched): it is still sent.
  if (order.customerConfirmationStatus === CustomerConfirmationStatus.CANCELLED && !order.deliveredAt) {
    return 'cancelled';
  }

  if (!config.metaCapi.enabled) {
    return 'disabled';
  }

  const eventDate = order.confirmedAt ?? order.deliveredAt;

  if (eventDate && now.getTime() - new Date(eventDate).getTime() > CAPI_MAX_EVENT_AGE_MS) {
    return 'too_old';
  }

  return undefined;
};

// Every status write is conditioned on PENDING: a concurrent SENT is never overwritten.
const updateIfPending = (orderId: IOrder['_id'] | string, update: Record<string, unknown>) =>
  Order.findOneAndUpdate({ _id: orderId, capiPurchaseStatus: CapiPurchaseStatus.PENDING }, update, { new: true });

const markSkipped = async (job: Job<CapiPurchaseJobData>, order: IOrder, reason: CapiSkipReason) => {
  const updated = await updateIfPending(order._id, { $set: { capiPurchaseStatus: CapiPurchaseStatus.SKIPPED } });

  if (!updated) {
    log.info({ jobId: job.id, orderId: order._id, reason }, 'CAPI purchase status changed concurrently, skip not recorded');
    return;
  }

  await OrderEvent.create({
    orderId: order._id,
    type: OrderEventType.CAPI_PURCHASE_SKIPPED,
    metadata: { reason }
  });

  log.info({ jobId: job.id, orderId: order._id, reason }, 'CAPI purchase skipped');
};

const markSent = async (job: Job<CapiPurchaseJobData>, order: IOrder, result: CapiSendResult) => {
  const { eventId, valueEur, fxRate } = result.meta;
  const updated = await updateIfPending(order._id, {
    $set: {
      capiPurchaseStatus: CapiPurchaseStatus.SENT,
      capiPurchaseSentAt: new Date(),
      capiEventId: eventId,
      capiValueEur: valueEur,
      capiFxRate: fxRate
    },
    $unset: { capiPurchaseError: '' }
  });

  if (!updated) {
    log.warn(
      { jobId: job.id, orderId: order._id, eventId, fbtraceId: result.fbtraceId },
      'CAPI purchase sent but status changed concurrently, result not recorded'
    );
    return;
  }

  await OrderEvent.create({
    orderId: order._id,
    type: OrderEventType.CAPI_PURCHASE_SENT,
    metadata: {
      eventId,
      fbtraceId: result.fbtraceId,
      hasFbc: Boolean(buildFbc(order)),
      hasFbp: Boolean(order.capiFbp),
      hasUserAgent: Boolean(order.capiClientUserAgent),
      valueEur
    }
  });

  log.info(
    { jobId: job.id, orderId: order._id, eventId, fbtraceId: result.fbtraceId, eventsReceived: result.eventsReceived },
    'CAPI purchase sent to Meta'
  );
};

// `attempts` = number of attempts consumed, including the one that just failed.
const markFailed = async (job: Job<CapiPurchaseJobData>, orderId: IOrder['_id'] | string, err: unknown, attempts: number) => {
  const error = toShortErrorMessage(err);
  const updated = await updateIfPending(orderId, {
    $set: { capiPurchaseStatus: CapiPurchaseStatus.FAILED, capiPurchaseError: error }
  });

  if (!updated) {
    log.info({ jobId: job.id, orderId }, 'CAPI purchase not pending, failure not recorded');
    return;
  }

  const metaError = err instanceof MetaCapiError ? err : undefined;

  await OrderEvent.create({
    orderId: updated._id,
    type: OrderEventType.CAPI_PURCHASE_FAILED,
    metadata: {
      error,
      status: metaError?.status,
      metaCode: metaError?.metaCode,
      metaSubcode: metaError?.metaSubcode,
      fbtraceId: metaError?.fbtraceId,
      retryable: metaError?.retryable,
      attempts
    }
  });

  log.error({ jobId: job.id, orderId, error, fbtraceId: metaError?.fbtraceId }, 'CAPI purchase failed permanently');
};

export const processCapiPurchaseJob = async (job: Job<CapiPurchaseJobData>) => {
  const { orderId } = job.data;
  const order = await Order.findById(orderId);

  if (!order) {
    log.warn({ jobId: job.id, orderId }, 'Order not found for CAPI purchase job');
    return;
  }

  if (order.capiPurchaseStatus === CapiPurchaseStatus.SENT || order.capiPurchaseSentAt) {
    log.info({ jobId: job.id, orderId }, 'CAPI purchase already sent, skipping duplicate job');
    return;
  }

  // Only a PENDING order can be written by this worker: sending anything else to Meta
  // would produce a result that cannot be recorded.
  if (order.capiPurchaseStatus !== CapiPurchaseStatus.PENDING) {
    log.info(
      { jobId: job.id, orderId, capiPurchaseStatus: order.capiPurchaseStatus },
      'CAPI purchase is not pending, job ignored'
    );
    return;
  }

  const skipReason = getSkipReason(order);

  if (skipReason) {
    await markSkipped(job, order, skipReason);
    return;
  }

  let result: CapiSendResult;

  try {
    result = await sendPurchase(order);
  } catch (err) {
    if (err instanceof MetaCapiError && !err.retryable) {
      if (isTooOldRejection(err)) {
        await markSkipped(job, order, 'too_old');
        return;
      }

      await markFailed(job, order._id, err, job.attemptsMade + 1);
      throw new UnrecoverableError(toShortErrorMessage(err));
    }

    const attemptsAllowed = job.opts.attempts ?? 1;
    const isLastAttempt = job.attemptsMade + 1 >= attemptsAllowed;

    if (isLastAttempt) {
      await markFailed(job, order._id, err, job.attemptsMade + 1);
    } else {
      log.warn(
        {
          jobId: job.id,
          orderId,
          attempt: job.attemptsMade + 1,
          attemptsAllowed,
          error: toShortErrorMessage(err),
          fbtraceId: err instanceof MetaCapiError ? err.fbtraceId : undefined
        },
        'CAPI purchase failed, will retry'
      );
    }

    throw err;
  }

  await markSent(job, order, result);
};

// BullMQ 'failed' listener. Covers final failures the processor could not record itself:
// a job stalled beyond the limit (failed without calling the processor) or an error thrown
// outside the send (MongoDB read, write of SENT) on the last attempt. The write is conditioned
// on PENDING, so a failure already recorded by the processor is not duplicated. Never throws.
export const handleCapiPurchaseJobFailed = async (job: Job<CapiPurchaseJobData> | undefined, err: Error) => {
  try {
    const error = toShortErrorMessage(err);

    if (!job) {
      log.error({ error }, 'CAPI purchase job failed without job context');
      return;
    }

    // Listener runs after moveToFailed: attemptsMade already counts the failed attempt.
    const attemptsAllowed = job.opts.attempts ?? 1;
    const isFinal = err?.name === 'UnrecoverableError' || job.attemptsMade >= attemptsAllowed;

    log[isFinal ? 'error' : 'warn'](
      { jobId: job.id, orderId: job.data.orderId, attemptsMade: job.attemptsMade, attemptsAllowed, error },
      isFinal ? 'CAPI purchase job failed permanently' : 'CAPI purchase job failed and will retry'
    );

    if (isFinal) {
      await markFailed(job, job.data.orderId, err, job.attemptsMade);
    }
  } catch (handlerErr) {
    log.error(
      { jobId: job?.id, orderId: job?.data?.orderId, error: toShortErrorMessage(handlerErr) },
      'Failed to record CAPI purchase job failure'
    );
  }
};

export const startCapiPurchaseWorker = () => {
  if (capiPurchaseWorker) {
    return capiPurchaseWorker;
  }

  capiPurchaseWorker = new Worker<CapiPurchaseJobData>(CAPI_PURCHASE_QUEUE_NAME, processCapiPurchaseJob, {
    connection: getRedisConnection()
  });

  capiPurchaseWorker.on('failed', (job, err) => {
    void handleCapiPurchaseJobFailed(job, err);
  });

  capiPurchaseWorker.on('error', err => {
    log.error({ error: toShortErrorMessage(err) }, 'CAPI purchase worker error');
  });

  log.info({ queueName: CAPI_PURCHASE_QUEUE_NAME }, 'CAPI purchase worker started');

  return capiPurchaseWorker;
};

export const stopCapiPurchaseWorker = async () => {
  if (!capiPurchaseWorker) {
    return;
  }

  await capiPurchaseWorker.close();
  capiPurchaseWorker = null;
  log.info({ queueName: CAPI_PURCHASE_QUEUE_NAME }, 'CAPI purchase worker stopped');
};
