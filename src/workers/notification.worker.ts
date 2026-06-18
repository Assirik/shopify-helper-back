import { Job, Worker } from 'bullmq';
import { Message, MessageStatus } from '../models/Message';
import { NotificationStatus, Order } from '../models/Order';
import {
  NOTIFICATION_QUEUE_NAME,
  SEND_ORDER_CONFIRMATION_JOB,
  SendOrderConfirmationJobData,
  getRedisConnection
} from '../queues/notification.queue';
import log from '../utilities/logger/logger';

let notificationWorker: Worker<SendOrderConfirmationJobData> | null = null;

const markMessageAsSending = async (job: Job<SendOrderConfirmationJobData>) => {
  const { orderId, messageId, channel } = job.data;

  const message = await Message.findByIdAndUpdate(
    messageId,
    {
      $set: {
        status: MessageStatus.SENDING
      },
      $inc: {
        attemptCount: 1
      }
    },
    { new: true }
  );

  if (!message) {
    throw new Error(`Message ${messageId} not found for notification job`);
  }

  log.info(
    {
      jobId: job.id,
      orderId,
      messageId,
      channel,
      attempt: job.attemptsMade + 1,
      messageAttemptCount: message.attemptCount
    },
    'Notification job picked by worker'
  );

  return message;
};

const processOrderConfirmation = async (job: Job<SendOrderConfirmationJobData>) => {
  await markMessageAsSending(job);

  throw new Error('Meta WhatsApp provider is not implemented yet');
};

const handleJobFailure = async (
  job: Job<SendOrderConfirmationJobData> | undefined,
  err: Error,
  willRetry: boolean
) => {
  if (!job) {
    log.error({ err }, 'Notification job failed without job context');
    return;
  }

  const { orderId, messageId, channel } = job.data;

  log[willRetry ? 'warn' : 'error'](
    {
      err,
      jobId: job.id,
      orderId,
      messageId,
      channel,
      attemptsMade: job.attemptsMade,
      attemptsAllowed: job.opts.attempts
    },
    willRetry ? 'Notification job failed and will retry' : 'Notification job failed permanently'
  );

  if (willRetry) {
    return;
  }

  await Message.findByIdAndUpdate(messageId, {
    $set: {
      status: MessageStatus.FAILED,
      errorCode: 'PROVIDER_NOT_AVAILABLE',
      errorMessage: err.message
    }
  });

  await Order.findByIdAndUpdate(orderId, {
    $set: {
      notificationStatus: NotificationStatus.FAILED
    }
  });
};

export const startNotificationWorker = () => {
  if (notificationWorker) {
    return notificationWorker;
  }

  notificationWorker = new Worker<SendOrderConfirmationJobData>(
    NOTIFICATION_QUEUE_NAME,
    async job => {
      if (job.name !== SEND_ORDER_CONFIRMATION_JOB) {
        throw new Error(`Unsupported notification job: ${job.name}`);
      }

      return processOrderConfirmation(job);
    },
    {
      connection: getRedisConnection()
    }
  );

  notificationWorker.on('completed', job => {
    log.info(
      {
        jobId: job.id,
        orderId: job.data.orderId,
        messageId: job.data.messageId,
        channel: job.data.channel
      },
      'Notification job completed'
    );
  });

  notificationWorker.on('failed', (job, err) => {
    const attemptsAllowed = job?.opts.attempts || 1;
    const attemptsMade = job?.attemptsMade || 0;
    const willRetry = attemptsMade < attemptsAllowed;

    handleJobFailure(job, err, willRetry).catch(error => {
      log.error({ err: error, jobId: job?.id }, 'Failed to persist notification job failure');
    });
  });

  notificationWorker.on('error', err => {
    log.error({ err }, 'Notification worker error');
  });

  log.info({ queueName: NOTIFICATION_QUEUE_NAME }, 'Notification worker started');

  return notificationWorker;
};

export const stopNotificationWorker = async () => {
  if (!notificationWorker) {
    return;
  }

  await notificationWorker.close();
  notificationWorker = null;
  log.info({ queueName: NOTIFICATION_QUEUE_NAME }, 'Notification worker stopped');
};
