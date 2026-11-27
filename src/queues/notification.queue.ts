import { JobsOptions, Queue } from 'bullmq';
import config from '../utilities/config/env.config';

export const NOTIFICATION_QUEUE_NAME = 'notifications';
export const SEND_ORDER_CONFIRMATION_JOB = 'sendOrderConfirmation';
export const SEND_ORDER_CONFIRMED_JOB = 'sendOrderConfirmed';
export const SEND_ORDER_CANCELLED_JOB = 'sendOrderCancelled';
export const SEND_CONFIRMATION_REMINDER_JOB = 'sendConfirmationReminder';
export const SEND_INITIAL_CONFIRMATION_REQUEST_JOB = 'sendInitialConfirmationRequest';

export const MAINTENANCE_QUEUE_NAME = 'confirmation-maintenance';
export const CONFIRMATION_SWEEP_JOB = 'confirmationSweep';
const CONFIRMATION_SWEEP_REPEAT_KEY = 'confirmation-sweep-tick';

export interface SendOrderConfirmationJobData {
  orderId: string;
  messageId: string;
  channel: 'whatsapp' | 'sms';
}

export interface InitialConfirmationRequestJobData {
  orderId: string;
  // Number of times the delayed request was already postponed behind a reminder still being
  // sent (C5.18). Absent on the job scheduled at ingestion.
  reminderWaitCount?: number;
}

export type NotificationJobData = SendOrderConfirmationJobData | InitialConfirmationRequestJobData;

export const getRedisConnection = () => {
  const redisUrl = new URL(config.redisUrl);

  return {
    host: redisUrl.hostname,
    port: Number(redisUrl.port || 6379),
    password: redisUrl.password || undefined,
    maxRetriesPerRequest: null
  };
};

export const notificationQueue = new Queue<NotificationJobData>(NOTIFICATION_QUEUE_NAME, {
  connection: getRedisConnection()
});

const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 5000
  },
  removeOnComplete: 100,
  removeOnFail: 500
};

// `jobId` is only set by the delayed initial request; the other callers (SMS fallback,
// manual resend) keep BullMQ's generated ids.
export const enqueueOrderConfirmation = async (data: SendOrderConfirmationJobData, options: { jobId?: string } = {}) => {
  return notificationQueue.add(
    SEND_ORDER_CONFIRMATION_JOB,
    data,
    options.jobId ? { ...defaultJobOptions, jobId: options.jobId } : defaultJobOptions
  );
};

export const enqueueOrderConfirmed = async (data: SendOrderConfirmationJobData) => {
  return notificationQueue.add(SEND_ORDER_CONFIRMED_JOB, data, defaultJobOptions);
};

export const enqueueOrderCancelled = async (data: SendOrderConfirmationJobData) => {
  return notificationQueue.add(SEND_ORDER_CANCELLED_JOB, data, defaultJobOptions);
};

export const enqueueConfirmationReminder = async (data: SendOrderConfirmationJobData) => {
  return notificationQueue.add(SEND_CONFIRMATION_REMINDER_JOB, data, defaultJobOptions);
};

// Deterministic id: a replayed Shopify webhook never schedules a second request.
// BullMQ rejects ':' in custom job ids.
export const getInitialConfirmationRequestJobId = (orderId: string) => `confirm-initial-${orderId}`;

// Send job the delayed initial request hands over to, keyed on its Message.
export const getInitialConfirmationSendJobId = (messageId: string) => `confirm-send-${messageId}`;

// Delayed first confirmation request (C5.6a). The worker re-checks the order when the delay
// expires and only then creates the Message and hands over to `enqueueOrderConfirmation`.
export const scheduleInitialConfirmationRequest = async (orderId: string) => {
  return notificationQueue.add(
    SEND_INITIAL_CONFIRMATION_REQUEST_JOB,
    { orderId },
    {
      ...defaultJobOptions,
      delay: config.confirmation.initialRequestDelayMinutes * 60 * 1000,
      jobId: getInitialConfirmationRequestJobId(orderId)
    }
  );
};

// C5.18: how long the delayed initial request waits, each time, for a reminder still being sent.
export const INITIAL_REQUEST_REMINDER_WAIT_MS = 2 * 60 * 1000;

// Deterministic id per postponement: a replayed delayed job never schedules a second wait.
export const getPostponedInitialConfirmationRequestJobId = (orderId: string, reminderWaitCount: number) =>
  `confirm-initial-${orderId}-wait-${reminderWaitCount}`;

// Re-runs the delayed initial request later, once the reminder being sent has settled (C5.18).
export const postponeInitialConfirmationRequest = async (orderId: string, reminderWaitCount: number) => {
  return notificationQueue.add(
    SEND_INITIAL_CONFIRMATION_REQUEST_JOB,
    { orderId, reminderWaitCount },
    {
      ...defaultJobOptions,
      delay: INITIAL_REQUEST_REMINDER_WAIT_MS,
      jobId: getPostponedInitialConfirmationRequestJobId(orderId, reminderWaitCount)
    }
  );
};

export const maintenanceQueue = new Queue(MAINTENANCE_QUEUE_NAME, {
  connection: getRedisConnection()
});

// Schedule (idempotently) the repeatable sweep that drives automatic reminders and expiration.
export const scheduleConfirmationSweep = async (intervalMinutes: number) => {
  return maintenanceQueue.add(
    CONFIRMATION_SWEEP_JOB,
    {},
    {
      repeat: { every: Math.max(1, intervalMinutes) * 60 * 1000, key: CONFIRMATION_SWEEP_REPEAT_KEY },
      removeOnComplete: 50,
      removeOnFail: 100
    }
  );
};
