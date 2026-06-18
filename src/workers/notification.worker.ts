import { Job, Worker } from 'bullmq';
import { Customer, ICustomer } from '../models/Customer';
import { Message, MessageChannel, MessageProvider, MessageStatus } from '../models/Message';
import { CustomerConfirmationStatus, IOrder, NotificationStatus, Order } from '../models/Order';
import { createOrderConfirmationButtonPayload, MetaWhatsAppProvider } from '../providers/metaWhatsApp.provider';
import { OrderConfirmationInput, ProviderError } from '../providers/messaging.provider';
import { buildOrderConfirmationSmsText, TermiiSmsProvider } from '../providers/termiiSms.provider';
import {
  NOTIFICATION_QUEUE_NAME,
  SEND_ORDER_CONFIRMATION_JOB,
  SendOrderConfirmationJobData,
  enqueueOrderConfirmation,
  getRedisConnection
} from '../queues/notification.queue';
import config from '../utilities/config/env.config';
import log from '../utilities/logger/logger';

let notificationWorker: Worker<SendOrderConfirmationJobData> | null = null;
const metaWhatsAppProvider = new MetaWhatsAppProvider();
const termiiSmsProvider = new TermiiSmsProvider();

const getPrimaryItemName = (order: IOrder) => {
  const firstItem = order.lineItems[0];
  const itemName = firstItem?.title || firstItem?.name;

  if (!itemName) {
    return 'votre article';
  }

  return order.lineItems.length > 1 ? `${itemName} + ${order.lineItems.length - 1} autre(s)` : itemName;
};

const getTotalQuantity = (order: IOrder) => {
  return order.lineItems.reduce((total, item) => total + item.quantity, 0).toString();
};

const getCustomerAddress = (customer: ICustomer | null) => {
  if (!customer) {
    return 'Adresse non précisée';
  }

  return [customer.address1, customer.address2, customer.city, customer.region, customer.country].filter(Boolean).join(', ') || 'Adresse non précisée';
};

const getPaymentMethod = (order: IOrder) => {
  if (order.isCashOnDelivery) {
    return 'Paiement à la livraison';
  }

  return order.paymentGatewayNames.length > 0 ? order.paymentGatewayNames.join(', ') : 'Mode de paiement non précisé';
};

const buildOrderConfirmationInput = (order: IOrder, customer: ICustomer | null): OrderConfirmationInput => {
  if (!order.customerPhoneE164) {
    throw new Error(`Order ${order._id.toString()} has no WhatsApp recipient phone`);
  }

  const buttonPayload = createOrderConfirmationButtonPayload(order._id.toString());

  return {
    orderId: order._id.toString(),
    to: order.customerPhoneE164,
    templateName: config.metaWhatsApp.templateName,
    templateLanguage: config.metaWhatsApp.templateLanguage,
    buttonPayload,
    variables: {
      greeting: 'Bonjour',
      customerName: order.customerName || customer?.fullName || 'Client',
      orderName: order.shopifyOrderName,
      itemName: getPrimaryItemName(order),
      amount: `${order.totalPrice} ${order.currency}`,
      quantity: getTotalQuantity(order),
      address: getCustomerAddress(customer),
      shippingNote: order.shippingTitle || 'Livraison standard',
      paymentMethod: getPaymentMethod(order)
    }
  };
};

const markMessageAsSending = async (job: Job<SendOrderConfirmationJobData>, input: OrderConfirmationInput) => {
  const { orderId, messageId, channel } = job.data;

  const message = await Message.findByIdAndUpdate(
    messageId,
    {
      $set: {
        status: MessageStatus.SENDING,
        templateName: input.templateName,
        templateLanguage: input.templateLanguage,
        buttonPayload: input.buttonPayload
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

const markSmsMessageAsSending = async (job: Job<SendOrderConfirmationJobData>, text: string) => {
  const { orderId, messageId, channel } = job.data;

  const message = await Message.findByIdAndUpdate(
    messageId,
    {
      $set: {
        status: MessageStatus.SENDING,
        providerResponse: {
          text
        }
      },
      $inc: {
        attemptCount: 1
      }
    },
    { new: true }
  );

  if (!message) {
    throw new Error(`Message ${messageId} not found for SMS notification job`);
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
    'SMS fallback job picked by worker'
  );

  return message;
};

const processOrderConfirmation = async (job: Job<SendOrderConfirmationJobData>) => {
  const order = await Order.findById(job.data.orderId);

  if (!order) {
    throw new Error(`Order ${job.data.orderId} not found for notification job`);
  }

  if (order.notificationStatus === NotificationStatus.SENT) {
    log.info(
      {
        jobId: job.id,
        orderId: order._id,
        messageId: job.data.messageId
      },
      'Order confirmation already sent, skipping duplicate notification job'
    );
    return;
  }

  const customer = order.customerId ? await Customer.findById(order.customerId) : null;
  const input = buildOrderConfirmationInput(order, customer);
  await markMessageAsSending(job, input);

  const result = await metaWhatsAppProvider.sendOrderConfirmation(input);

  await Message.findByIdAndUpdate(job.data.messageId, {
    $set: {
      status: MessageStatus.SENT,
      providerMessageId: result.providerMessageId,
      providerResponse: result.response
    }
  });

  await Order.findByIdAndUpdate(order._id, {
    $set: {
      notificationStatus: NotificationStatus.SENT
    }
  });

  log.info(
    {
      jobId: job.id,
      orderId: order._id,
      messageId: job.data.messageId,
      providerMessageId: result.providerMessageId,
      buttonPayload: input.buttonPayload
    },
    'Order confirmation sent through Meta WhatsApp'
  );

  return result;
};

const processSmsFallback = async (job: Job<SendOrderConfirmationJobData>) => {
  const order = await Order.findById(job.data.orderId);

  if (!order) {
    throw new Error(`Order ${job.data.orderId} not found for SMS fallback job`);
  }

  if (!order.customerPhoneE164) {
    throw new Error(`Order ${order._id.toString()} has no SMS recipient phone`);
  }

  const existingMessage = await Message.findById(job.data.messageId);

  if (existingMessage?.status === MessageStatus.SENT) {
    log.info(
      {
        jobId: job.id,
        orderId: order._id,
        messageId: job.data.messageId
      },
      'SMS fallback already sent, skipping duplicate notification job'
    );
    return;
  }

  const text = buildOrderConfirmationSmsText({
    customerName: order.customerName,
    orderName: order.shopifyOrderName,
    totalPrice: order.totalPrice,
    currency: order.currency
  });

  await markSmsMessageAsSending(job, text);

  const result = await termiiSmsProvider.sendSms({
    orderId: order._id.toString(),
    to: order.customerPhoneE164,
    text
  });

  await Message.findByIdAndUpdate(job.data.messageId, {
    $set: {
      status: MessageStatus.SENT,
      providerMessageId: result.providerMessageId,
      providerResponse: result.response
    }
  });

  await Order.findByIdAndUpdate(order._id, {
    $set: {
      notificationStatus: NotificationStatus.PARTIALLY_SENT,
      customerConfirmationStatus: CustomerConfirmationStatus.SMS_ONLY
    }
  });

  log.info(
    {
      jobId: job.id,
      orderId: order._id,
      messageId: job.data.messageId,
      providerMessageId: result.providerMessageId
    },
    'Order notification sent through Termii SMS fallback'
  );

  return result;
};

const enqueueSmsFallback = async (job: Job<SendOrderConfirmationJobData>) => {
  const order = await Order.findById(job.data.orderId);

  if (!order) {
    throw new Error(`Order ${job.data.orderId} not found while creating SMS fallback`);
  }

  if (!order.customerPhoneE164) {
    throw new Error(`Order ${order._id.toString()} has no phone for SMS fallback`);
  }

  const smsMessage = await Message.create({
    orderId: order._id,
    channel: MessageChannel.SMS,
    provider: MessageProvider.TERMII,
    status: MessageStatus.QUEUED,
    fallbackOfMessageId: job.data.messageId
  });

  const fallbackJob = await enqueueOrderConfirmation({
    orderId: order._id.toString(),
    messageId: smsMessage._id.toString(),
    channel: MessageChannel.SMS
  });

  log.info(
    {
      orderId: order._id,
      whatsappMessageId: job.data.messageId,
      smsMessageId: smsMessage._id,
      fallbackJobId: fallbackJob.id
    },
    'Enqueued Termii SMS fallback after WhatsApp failure'
  );
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
      errorCode: err instanceof ProviderError ? err.code : 'PROVIDER_ERROR',
      errorMessage: err.message
    }
  });

  if (channel === MessageChannel.WHATSAPP) {
    try {
      await enqueueSmsFallback(job);
      return;
    } catch (fallbackErr) {
      log.error(
        { err: fallbackErr, jobId: job.id, orderId, messageId },
        'Failed to enqueue SMS fallback after WhatsApp failure'
      );
    }
  }

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

      if (job.data.channel === MessageChannel.SMS) {
        return processSmsFallback(job);
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
