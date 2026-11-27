import { Job, UnrecoverableError, Worker } from 'bullmq';
import { CapiPurchaseStatus, CapiSkipReason as OrderCapiSkipReason, IOrder, Order } from '../models/Order';
import { OrderEvent, OrderEventType } from '../models/OrderEvent';
import { CapiSendResult, MetaCapiError, buildFbc, sendPurchase } from '../providers/metaCapi.provider';
import { CAPI_PURCHASE_QUEUE_NAME, CapiPurchaseJobData } from '../queues/capi.queue';
import { getRedisConnection } from '../queues/notification.queue';
import config from '../utilities/config/env.config';
import log from '../utilities/logger/logger';
import { captureJobFailure } from '../utilities/sentry/sentry';
import { triggerCapiPurchase } from '../utilities/services/capiPurchase.service';
import { CAPI_MAX_EVENT_AGE_MS, getOrderCapiSkipReason } from '../utilities/services/orderCapabilities.service';

// The values of the Order enum, stored in `capiSkipReason`.
export type CapiSkipReason = `${OrderCapiSkipReason}`;

// Meta rejects events older than 7 days, with a 1 h margin (shared with the resend rules).
export { CAPI_MAX_EVENT_AGE_MS };

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

// Removes the Meta access token from any text before it is stored or logged.
const redactSecrets = (text: string): string => {
  let message = text;
  const token = config.metaCapi.accessToken;

  if (token) {
    message = message.split(token).join('[redacted]');
  }

  return message.replace(/access_token=[^\s&"']+/gi, 'access_token=[redacted]');
};

// Short, token-free error text stored on the order and in the event.
export const toShortErrorMessage = (err: unknown): string => {
  const message = redactSecrets(err instanceof Error ? err.message : String(err));

  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 1)}…` : message;
};

export const getSkipReason = (order: IOrder, now: Date = new Date()): CapiSkipReason | undefined => {
  // Test order, cancelled on Shopify, or neither confirmed nor delivered: shared with the
  // admin resend eligibility (orderCapabilities.service).
  const orderSkipReason = getOrderCapiSkipReason(order);

  if (orderSkipReason) {
    return orderSkipReason;
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

// True when the skip was recorded (the order was still PENDING).
const markSkipped = async (job: Job<CapiPurchaseJobData>, order: IOrder, reason: CapiSkipReason): Promise<boolean> => {
  const updated = await updateIfPending(order._id, {
    $set: { capiPurchaseStatus: CapiPurchaseStatus.SKIPPED, capiSkipReason: reason }
  });

  if (!updated) {
    log.info({ jobId: job.id, orderId: order._id, reason }, 'CAPI purchase status changed concurrently, skip not recorded');
    return false;
  }

  await OrderEvent.create({
    orderId: order._id,
    type: OrderEventType.CAPI_PURCHASE_SKIPPED,
    metadata: { reason }
  });

  log.info({ jobId: job.id, orderId: order._id, reason }, 'CAPI purchase skipped');
  return true;
};

// The order may have been confirmed or delivered between the read above and the skip write:
// its own trigger then found the Purchase still PENDING and did nothing. Read it again and,
// if it is now a sale, take the Purchase back as that trigger would have.
const retakeIfNowASale = async (job: Job<CapiPurchaseJobData>, orderId: IOrder['_id']) => {
  const current = await Order.findById(orderId);

  if (current && !getOrderCapiSkipReason(current)) {
    log.info({ jobId: job.id, orderId }, 'Order became a sale while the CAPI purchase was skipped, taking it back');
    await triggerCapiPurchase(orderId, 'confirmation');
  }
};

// A certain refusal by Meta: an HTTP 4xx answer that is not retried, so the event was not
// counted. Any other final failure (timeout, network, 5xx, 429, error after Meta accepted
// the event) is ambiguous: Meta may have received it.
export const isDefinitiveMetaRefusal = (err: unknown): boolean =>
  err instanceof MetaCapiError &&
  !err.retryable &&
  err.status !== undefined &&
  err.status >= 400 &&
  err.status < 500;

// Whether a send failure may have reached Meta. A MetaCapiError raised before the HTTP call
// (missing configuration or data) did not, nor did a certain refusal. Any other error thrown
// by the send cannot be placed before or after the call: counted as possibly received.
export const mayHaveReachedMeta = (err: unknown): boolean => {
  if (err instanceof MetaCapiError) {
    return err.requestSent && !isDefinitiveMetaRefusal(err);
  }

  return true;
};

// Warnings Meta returned with an accepted event. Never throws: logging must not change the job.
const logMetaWarnings = (job: Job<CapiPurchaseJobData>, orderId: IOrder['_id'], result: CapiSendResult) => {
  try {
    if (!result.metaMessages?.length) return;

    log.warn(
      {
        jobId: job.id,
        orderId,
        eventId: result.meta.eventId,
        fbtraceId: result.fbtraceId,
        messages: result.metaMessages.map(redactSecrets)
      },
      'Meta CAPI accepted the event with warnings'
    );
  } catch {
    // ignored on purpose
  }
};

// Durable fact, written whatever the status and never cleared: `$min` keeps the first attempt.
const markPossiblyReceived = async (job: Job<CapiPurchaseJobData>, orderId: IOrder['_id'] | string, attemptAt: Date) => {
  await Order.updateOne({ _id: orderId }, { $min: { capiPossiblyReceivedAt: attemptAt } });
  log.warn({ jobId: job.id, orderId, attemptAt }, 'CAPI purchase may have reached Meta, marked as possibly received');
};

// True when the SENT result was recorded.
const markSent = async (job: Job<CapiPurchaseJobData>, order: IOrder, result: CapiSendResult): Promise<boolean> => {
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
    return false;
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
  return true;
};

// `attempts` = number of attempts consumed, including the one that just failed.
// `possiblyReceived`: an earlier attempt may have reached Meta (`capiPossiblyReceivedAt`), so
// even a certain refusal now is not a definitive failure. True when the failure was recorded.
const markFailed = async (
  job: Job<CapiPurchaseJobData>,
  orderId: IOrder['_id'] | string,
  err: unknown,
  attempts: number,
  possiblyReceived: boolean
): Promise<boolean> => {
  const error = toShortErrorMessage(err);
  const updated = await updateIfPending(orderId, {
    $set: {
      capiPurchaseStatus: CapiPurchaseStatus.FAILED,
      capiPurchaseError: error,
      capiPurchaseFailedAt: new Date(),
      capiPurchaseFailureDefinitive: isDefinitiveMetaRefusal(err) && !possiblyReceived
    }
  });

  if (!updated) {
    log.info({ jobId: job.id, orderId }, 'CAPI purchase not pending, failure not recorded');
    return false;
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
  return true;
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
    const skipped = await markSkipped(job, order, skipReason);

    if (skipped && skipReason === 'cancelled') {
      await retakeIfNowASale(job, order._id);
    }

    return;
  }

  let result: CapiSendResult;
  const attemptAt = new Date();

  try {
    result = await sendPurchase(order);
  } catch (err) {
    // Every attempt that may have reached Meta is recorded, retried or final.
    const reachedMeta = mayHaveReachedMeta(err);

    if (reachedMeta) {
      await markPossiblyReceived(job, order._id, attemptAt);
    }

    // An earlier attempt of this job counts too: its mark may have failed to be written.
    const possiblyReceived = reachedMeta || Boolean(order.capiPossiblyReceivedAt) || job.attemptsMade > 0;

    if (err instanceof MetaCapiError && !err.retryable) {
      if (isTooOldRejection(err)) {
        await markSkipped(job, order, 'too_old');
        return;
      }

      await markFailed(job, order._id, err, job.attemptsMade + 1, possiblyReceived);
      throw new UnrecoverableError(toShortErrorMessage(err));
    }

    const attemptsAllowed = job.opts.attempts ?? 1;
    const isLastAttempt = job.attemptsMade + 1 >= attemptsAllowed;

    if (isLastAttempt) {
      await markFailed(job, order._id, err, job.attemptsMade + 1, possiblyReceived);
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

  // Meta accepted the event: if SENT cannot be recorded (concurrent change, MongoDB error),
  // the order must keep the fact that Meta received it.
  let recorded = false;

  try {
    recorded = await markSent(job, order, result);
  } finally {
    logMetaWarnings(job, order._id, result);

    if (!recorded) {
      await markPossiblyReceived(job, order._id, attemptAt);
    }
  }
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
      // Failure the processor did not record (stalled job, error outside the send): whether
      // the last attempt reached Meta is unknown, so it counts as possibly received.
      const recorded = await markFailed(job, job.data.orderId, err, job.attemptsMade, true);

      if (recorded) {
        await markPossiblyReceived(job, job.data.orderId, job.processedOn ? new Date(job.processedOn) : new Date());
      }
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
    captureJobFailure(CAPI_PURCHASE_QUEUE_NAME, job, err);
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
