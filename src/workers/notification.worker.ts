import { Job, Worker } from 'bullmq';
import { Customer, ICustomer } from '../models/Customer';
import { Message, MessageChannel, MessageProvider, MessageStatus, TemplatePurpose } from '../models/Message';
import { CustomerConfirmationStatus, IOrder, NotificationStatus, Order } from '../models/Order';
import { createOrderConfirmationButtonPayload, MetaWhatsAppProvider } from '../providers/metaWhatsApp.provider';
import { OrderConfirmationInput, ProviderError, TemplateVariable } from '../providers/messaging.provider';
import { buildOrderConfirmationSmsText, TermiiSmsProvider } from '../providers/termiiSms.provider';
import {
  CONFIRMATION_SWEEP_JOB,
  MAINTENANCE_QUEUE_NAME,
  NOTIFICATION_QUEUE_NAME,
  SEND_CONFIRMATION_REMINDER_JOB,
  SEND_ORDER_CANCELLED_JOB,
  SEND_ORDER_CONFIRMED_JOB,
  SEND_ORDER_CONFIRMATION_JOB,
  SendOrderConfirmationJobData,
  enqueueOrderConfirmation,
  getRedisConnection
} from '../queues/notification.queue';
import config from '../utilities/config/env.config';
import log from '../utilities/logger/logger';
import { OrderConfirmationService } from '../utilities/services/orderConfirmation.service';

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

// Shopify stores prices like "25000.00"; XOF has no subunits, so render a clean number
// (drops trailing zeros, keeps real decimals if any). Falls back to the raw value.
const formatAmount = (price: string) => {
  const value = Number(price);
  return Number.isFinite(value) ? value.toString() : price;
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

// Senegal (Africa/Dakar) runs on UTC year-round, so UTC hours map directly to local time.
const getGreeting = () => {
  const hour = new Date().getUTCHours();
  return hour >= 4 && hour < 18 ? 'Bonjour' : 'Bonsoir';
};

// Each template purpose maps to the exact named variables of its Meta template.
const buildTemplateVariables = (
  order: IOrder,
  customer: ICustomer | null,
  templatePurpose: TemplatePurpose
): TemplateVariable[] => {
  const greeting = getGreeting();
  const orderNo = order.shopifyOrderName;
  const customerName = order.customerName || customer?.fullName || 'Client';

  // Template `order_confirmed`: "Salut {{name}}, Nous préparons votre commande {{order_no}}..."
  if (templatePurpose === TemplatePurpose.ORDER_CONFIRMED) {
    return [
      { name: 'name', value: customerName },
      { name: 'order_no', value: orderNo }
    ];
  }

  // Template `order_canceled_by_admin`: "👋 {{greeting}}, ... annulé la commande {{order_no}}..."
  if (templatePurpose === TemplatePurpose.ORDER_CANCELLED) {
    return [
      { name: 'greeting', value: greeting },
      { name: 'order_no', value: orderNo }
    ];
  }

  // Template `order_confirm_auto_schedule` (confirmation request & reminder).
  // `amount` is the number only; the currency (XOF) is hard-coded in the template.
  return [
    { name: 'greeting', value: greeting },
    { name: 'name', value: customerName },
    { name: 'order_no', value: orderNo },
    { name: 'item', value: getPrimaryItemName(order) },
    { name: 'amount', value: formatAmount(order.totalPrice) },
    { name: 'qty', value: getTotalQuantity(order) },
    { name: 'address', value: getCustomerAddress(customer) },
    { name: 'shipping_note', value: order.shippingTitle || 'Livraison standard' },
    { name: 'payment_method', value: getPaymentMethod(order) }
  ];
};

const buildOrderConfirmationInput = (
  order: IOrder,
  customer: ICustomer | null,
  templateName: string,
  templatePurpose: TemplatePurpose,
  buttonPayload?: string
): OrderConfirmationInput => {
  if (!order.customerPhoneE164) {
    throw new Error(`Order ${order._id.toString()} has no WhatsApp recipient phone`);
  }

  return {
    orderId: order._id.toString(),
    to: order.customerPhoneE164,
    templateName,
    templateLanguage: config.metaWhatsApp.templateLanguage,
    buttonPayload,
    variables: buildTemplateVariables(order, customer, templatePurpose)
  };
};

const markMessageAsSending = async (
  job: Job<SendOrderConfirmationJobData>,
  input: OrderConfirmationInput,
  templatePurpose: TemplatePurpose
) => {
  const { orderId, messageId, channel } = job.data;

  const message = await Message.findByIdAndUpdate(
    messageId,
    {
      $set: {
        status: MessageStatus.SENDING,
        templateName: input.templateName,
        templateLanguage: input.templateLanguage,
        templatePurpose,
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
        templatePurpose: TemplatePurpose.SMS_FALLBACK,
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

const sendMetaTemplate = async (
  job: Job<SendOrderConfirmationJobData>,
  templateName: string,
  templatePurpose: TemplatePurpose,
  buttonPayload?: string
) => {
  const order = await Order.findById(job.data.orderId);

  if (!order) {
    throw new Error(`Order ${job.data.orderId} not found for notification job`);
  }

  const existing = await Message.findById(job.data.messageId);

  if (existing?.status === MessageStatus.SENT) {
    log.info(
      {
        jobId: job.id,
        orderId: order._id,
        messageId: job.data.messageId,
        templatePurpose
      },
      'WhatsApp template already sent, skipping duplicate job'
    );

    return { order, result: undefined };
  }

  const customer = order.customerId ? await Customer.findById(order.customerId) : null;
  const input = buildOrderConfirmationInput(order, customer, templateName, templatePurpose, buttonPayload);
  const message = await markMessageAsSending(job, input, templatePurpose);
  const result = await metaWhatsAppProvider.sendOrderConfirmation(input);

  await Message.findByIdAndUpdate(job.data.messageId, {
    $set: {
      status: MessageStatus.SENT,
      providerMessageId: result.providerMessageId,
      providerResponse: result.response
    },
    $unset: {
      errorCode: '',
      errorMessage: ''
    },
    $push: {
      attempts: {
        attemptNumber: message.attemptCount,
        status: MessageStatus.SENT,
        providerMessageId: result.providerMessageId,
        providerResponse: result.response,
        at: new Date()
      }
    }
  });

  log.info(
    {
      jobId: job.id,
      orderId: order._id,
      messageId: job.data.messageId,
      providerMessageId: result.providerMessageId,
      templateName,
      templatePurpose,
      buttonPayload
    },
    'WhatsApp template sent through Meta'
  );

  return { order, result };
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

  const buttonPayload = createOrderConfirmationButtonPayload(order._id.toString());
  const { result } = await sendMetaTemplate(
    job,
    config.metaWhatsApp.templateName,
    TemplatePurpose.ORDER_CONFIRMATION_REQUEST,
    buttonPayload
  );

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
      providerMessageId: result?.providerMessageId,
      buttonPayload
    },
    'Order confirmation sent through Meta WhatsApp'
  );

  return result;
};

const processOrderCancelled = async (job: Job<SendOrderConfirmationJobData>) => {
  const { result } = await sendMetaTemplate(job, config.metaWhatsApp.cancelledTemplateName, TemplatePurpose.ORDER_CANCELLED);

  return result;
};

const processOrderConfirmed = async (job: Job<SendOrderConfirmationJobData>) => {
  const { result } = await sendMetaTemplate(job, config.metaWhatsApp.confirmedTemplateName, TemplatePurpose.ORDER_CONFIRMED);

  return result;
};

const processConfirmationReminder = async (job: Job<SendOrderConfirmationJobData>) => {
  const buttonPayload = createOrderConfirmationButtonPayload(job.data.orderId);
  const { result } = await sendMetaTemplate(
    job,
    config.metaWhatsApp.templateName,
    TemplatePurpose.REMINDER,
    buttonPayload
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

  const message = await markSmsMessageAsSending(job, text);

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
    },
    $unset: {
      errorCode: '',
      errorMessage: ''
    },
    $push: {
      attempts: {
        attemptNumber: message.attemptCount,
        status: MessageStatus.SENT,
        providerMessageId: result.providerMessageId,
        providerResponse: result.response,
        at: new Date()
      }
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
    templatePurpose: TemplatePurpose.SMS_FALLBACK,
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

  const errorCode = err instanceof ProviderError ? err.code : 'PROVIDER_ERROR';

  await Message.findByIdAndUpdate(messageId, {
    $set: {
      status: MessageStatus.FAILED,
      errorCode,
      errorMessage: err.message
    },
    $push: {
      attempts: {
        status: MessageStatus.FAILED,
        errorCode,
        errorMessage: err.message,
        at: new Date()
      }
    }
  });

  const isInitialWhatsAppConfirmation = job.name === SEND_ORDER_CONFIRMATION_JOB && channel === MessageChannel.WHATSAPP;

  if (isInitialWhatsAppConfirmation) {
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

  const shouldUpdateOrderNotificationStatus = job.name === SEND_ORDER_CONFIRMATION_JOB || channel === MessageChannel.SMS;

  if (!shouldUpdateOrderNotificationStatus) {
    log.warn(
      { jobId: job.id, jobName: job.name, orderId, messageId, channel },
      'Non-initial WhatsApp template failed; order notification status left unchanged'
    );
    return;
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
        if (job.name === SEND_ORDER_CONFIRMED_JOB) {
          return processOrderConfirmed(job);
        }

        if (job.name === SEND_ORDER_CANCELLED_JOB) {
          return processOrderCancelled(job);
        }

        if (job.name === SEND_CONFIRMATION_REMINDER_JOB) {
          return processConfirmationReminder(job);
        }

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

let maintenanceWorker: Worker | null = null;

export const startMaintenanceWorker = () => {
  if (maintenanceWorker) {
    return maintenanceWorker;
  }

  maintenanceWorker = new Worker(
    MAINTENANCE_QUEUE_NAME,
    async job => {
      if (job.name !== CONFIRMATION_SWEEP_JOB) {
        throw new Error(`Unsupported maintenance job: ${job.name}`);
      }

      return OrderConfirmationService.runConfirmationMaintenance();
    },
    {
      connection: getRedisConnection()
    }
  );

  maintenanceWorker.on('failed', (job, err) => {
    log.error({ err, jobId: job?.id }, 'Confirmation maintenance job failed');
  });

  maintenanceWorker.on('error', err => {
    log.error({ err }, 'Maintenance worker error');
  });

  log.info({ queueName: MAINTENANCE_QUEUE_NAME }, 'Maintenance worker started');

  return maintenanceWorker;
};

export const stopMaintenanceWorker = async () => {
  if (!maintenanceWorker) {
    return;
  }

  await maintenanceWorker.close();
  maintenanceWorker = null;
  log.info({ queueName: MAINTENANCE_QUEUE_NAME }, 'Maintenance worker stopped');
};
