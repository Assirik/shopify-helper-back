import { JobsOptions, Queue } from 'bullmq';
import config from '../utilities/config/env.config';

export const NOTIFICATION_QUEUE_NAME = 'notifications';
export const SEND_ORDER_CONFIRMATION_JOB = 'sendOrderConfirmation';

export interface SendOrderConfirmationJobData {
  orderId: string;
  messageId: string;
  channel: 'whatsapp' | 'sms';
}

const getRedisConnection = () => {
  const redisUrl = new URL(config.redisUrl);

  return {
    host: redisUrl.hostname,
    port: Number(redisUrl.port || 6379),
    password: redisUrl.password || undefined
  };
};

export const notificationQueue = new Queue<SendOrderConfirmationJobData>(NOTIFICATION_QUEUE_NAME, {
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

export const enqueueOrderConfirmation = async (data: SendOrderConfirmationJobData) => {
  return notificationQueue.add(SEND_ORDER_CONFIRMATION_JOB, data, defaultJobOptions);
};
