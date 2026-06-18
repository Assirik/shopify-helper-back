import { Job, Worker } from 'bullmq';
import { Customer, ICustomer } from '../models/Customer';
import { Message, MessageStatus } from '../models/Message';
import { IOrder, NotificationStatus, Order } from '../models/Order';
import { createOrderConfirmationButtonPayload, MetaWhatsAppProvider } from '../providers/metaWhatsApp.provider';
import { OrderConfirmationInput, ProviderError } from '../providers/messaging.provider';
import {
  NOTIFICATION_QUEUE_NAME,
  SEND_ORDER_CONFIRMATION_JOB,
  SendOrderConfirmationJobData,
  getRedisConnection
} from '../queues/notification.queue';
import config from '../utilities/config/env.config';
import log from '../utilities/logger/logger';

let notificationWorker: Worker<SendOrderConfirmationJobData> | null = null;
const metaWhatsAppProvider = new MetaWhatsAppProvider();

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
