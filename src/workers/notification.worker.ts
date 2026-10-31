import { Job, Worker } from 'bullmq';
import { Customer, ICustomer } from '../models/Customer';
import { Message, MessageChannel, MessageProvider, MessageStatus, TemplatePurpose } from '../models/Message';
import {
  AttentionReasonCode,
  CustomerConfirmationStatus,
  IOrder,
  NotificationStatus,
  Order
} from '../models/Order';
import { createOrderConfirmationButtonPayload, MetaWhatsAppProvider } from '../providers/metaWhatsApp.provider';
import { OrderConfirmationInput, ProviderError, TemplateVariable } from '../providers/messaging.provider';
import { buildOrderConfirmationSmsText, TermiiSmsProvider } from '../providers/termiiSms.provider';
import {
  CONFIRMATION_SWEEP_JOB,
  MAINTENANCE_QUEUE_NAME,
  NOTIFICATION_QUEUE_NAME,
  SEND_CONFIRMATION_REMINDER_JOB,
  SEND_INITIAL_CONFIRMATION_REQUEST_JOB,
  SEND_ORDER_CANCELLED_JOB,
  SEND_ORDER_CONFIRMED_JOB,
  SEND_ORDER_CONFIRMATION_JOB,
  InitialConfirmationRequestJobData,
  SendOrderConfirmationJobData,
  enqueueOrderConfirmation,
  getInitialConfirmationSendJobId,
  getRedisConnection,
  postponeInitialConfirmationRequest
} from '../queues/notification.queue';
import config from '../utilities/config/env.config';
import log from '../utilities/logger/logger';
import { ChatwootOutboundMirrorService } from '../utilities/services/chatwootOutboundMirror.service';
import {
  CONFIRMABLE_BY_BUTTON,
  OrderConfirmationService,
  TERMINAL_OPERATIONAL_STATUSES
} from '../utilities/services/orderConfirmation.service';
import {
  MessageVariableConfigService,
  ResolvedMessageVariables
} from '../utilities/services/messageVariableConfig.service';

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
export const buildTemplateVariables = (
  order: IOrder,
  customer: ICustomer | null,
  templatePurpose: TemplatePurpose,
  overrides: ResolvedMessageVariables = {}
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
    { name: 'shipping_note', value: overrides.shippingNote || order.shippingTitle || 'Livraison standard' },
    {
      name: 'payment_method',
      value: order.isCashOnDelivery && overrides.paymentMethod ? overrides.paymentMethod : getPaymentMethod(order)
    }
  ];
};

const buildOrderConfirmationInput = (
  order: IOrder,
  customer: ICustomer | null,
  templateName: string,
  templatePurpose: TemplatePurpose,
  buttonPayload?: string,
  overrides: ResolvedMessageVariables = {}
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
    variables: buildTemplateVariables(order, customer, templatePurpose, overrides)
  };
};

// Only the confirmation request and reminder templates use shipping_note / payment_method.
const PURPOSES_WITH_REGION_VARIANTS: TemplatePurpose[] = [
  TemplatePurpose.ORDER_CONFIRMATION_REQUEST,
  TemplatePurpose.REMINDER
];

export const getOrderDeliveryRegion = (
  order: Pick<IOrder, 'deliveryRegionCode' | 'deliveryRegion' | 'shippingRegion'>
) => order.deliveryRegionCode || order.deliveryRegion || order.shippingRegion;

// Error code of a confirmation request (initial, SMS fallback or reminder) deliberately not
// sent because the order no longer awaits confirmation (same idea as `NOTIFICATION_SKIPPED`).
export const ORDER_NO_LONGER_PENDING = 'ORDER_NO_LONGER_PENDING';

// Error code of an initial confirmation request not sent because a request (a reminder)
// already reached the customer: a new send goes through the reminder, its limit and cooldown.
export const CONFIRMATION_REQUEST_ALREADY_SENT = 'CONFIRMATION_REQUEST_ALREADY_SENT';

// A Message in one of these statuses left the platform: it is never sent again nor rewritten.
// The status webhook can move a sent message to `delivered` / `read` before a job replay.
const MESSAGE_ALREADY_SENT_STATUSES = [MessageStatus.SENT, MessageStatus.DELIVERED, MessageStatus.READ];

const isMessageAlreadySent = (status?: MessageStatus) =>
  Boolean(status && MESSAGE_ALREADY_SENT_STATUSES.includes(status));

// Why a confirmation request must not be sent anymore, or null when the order can still be
// confirmed by its button. Checked on the freshly loaded order right before the provider call.
export const getConfirmationSendSkipReason = (
  order: Pick<IOrder, 'customerConfirmationStatus' | 'shopifyCancelledAt' | 'operationalStatus'>
) => {
  if (!CONFIRMABLE_BY_BUTTON.includes(order.customerConfirmationStatus)) {
    return 'not_confirmable';
  }

  if (order.shopifyCancelledAt) {
    return 'cancelled_on_shopify';
  }

  if (order.operationalStatus && TERMINAL_OPERATIONAL_STATUSES.includes(order.operationalStatus)) {
    return 'terminal_operational_status';
  }

  return null;
};

// Write-time counterpart of `getConfirmationSendSkipReason`. In MongoDB both `null` and `$nin`
// also match a missing field, so a regular pending order still matches.
const STILL_CONFIRMABLE_FILTER = {
  customerConfirmationStatus: { $in: CONFIRMABLE_BY_BUTTON },
  shopifyCancelledAt: null,
  operationalStatus: { $nin: TERMINAL_OPERATIONAL_STATUSES }
};

// Records a confirmation request deliberately not sent: no attempt, no retry, no fallback.
// Conditional write: a message that already left is never rewritten.
const markMessageAsNotSent = async (
  job: Job<SendOrderConfirmationJobData>,
  order: IOrder,
  skipReason: string,
  errorCode = ORDER_NO_LONGER_PENDING,
  errorMessage = `Order no longer awaits confirmation (${skipReason}), nothing sent`
) => {
  await Message.updateOne(
    { _id: job.data.messageId, status: { $nin: MESSAGE_ALREADY_SENT_STATUSES } },
    { $set: { status: MessageStatus.FAILED, errorCode, errorMessage } }
  );

  log.info(
    {
      jobId: job.id,
      jobName: job.name,
      orderId: order._id,
      messageId: job.data.messageId,
      channel: job.data.channel,
      skipReason,
      customerConfirmationStatus: order.customerConfirmationStatus,
      operationalStatus: order.operationalStatus
    },
    'Confirmation request not sent, order no longer awaits confirmation'
  );
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
  buttonPayload?: string,
  options: { requireConfirmableOrder?: boolean } = {}
): Promise<{
  order: IOrder;
  result?: Awaited<ReturnType<MetaWhatsAppProvider['sendOrderConfirmation']>>;
  skipReason?: string;
}> => {
  const order = await Order.findById(job.data.orderId);

  if (!order) {
    throw new Error(`Order ${job.data.orderId} not found for notification job`);
  }

  const existing = await Message.findById(job.data.messageId);

  if (isMessageAlreadySent(existing?.status)) {
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

  // Confirmation requests only: the order may have been confirmed, cancelled or closed since
  // the job was queued (or between two retries). Nothing is sent and the job ends normally.
  const skipReason = options.requireConfirmableOrder ? getConfirmationSendSkipReason(order) : null;

  if (skipReason) {
    await markMessageAsNotSent(job, order, skipReason);
    return { order, result: undefined, skipReason };
  }

  const customer = order.customerId ? await Customer.findById(order.customerId) : null;
  const overrides = PURPOSES_WITH_REGION_VARIANTS.includes(templatePurpose)
    ? await MessageVariableConfigService.resolveForRegion(getOrderDeliveryRegion(order))
    : {};
  const input = buildOrderConfirmationInput(order, customer, templateName, templatePurpose, buttonPayload, overrides);
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

  // Mirror the sent template into Chatwoot so agents see what the customer's reply
  // answers. Fire-and-forget: a Chatwoot outage must never fail the notification job.
  void ChatwootOutboundMirrorService.mirrorTemplateMessage({
    to: input.to,
    customerName: order.customerName || customer?.fullName || 'Client',
    templateName,
    templateLanguage: input.templateLanguage,
    variables: input.variables,
    providerMessageId: result.providerMessageId
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
    // A request (e.g. a reminder) already reached the customer: this Message (a manual retry
    // or a late attempt) is closed explicitly instead of staying queued forever.
    await markMessageAsNotSent(
      job,
      order,
      'already_sent',
      CONFIRMATION_REQUEST_ALREADY_SENT,
      'A confirmation request was already sent for this order, use a reminder instead'
    );
    return;
  }

  const buttonPayload = createOrderConfirmationButtonPayload(order._id.toString());
  const { result, skipReason } = await sendMetaTemplate(
    job,
    config.metaWhatsApp.templateName,
    TemplatePurpose.ORDER_CONFIRMATION_REQUEST,
    buttonPayload,
    { requireConfirmableOrder: true }
  );

  if (skipReason) {
    await settlePendingInitialNotification(order._id.toString(), NotificationStatus.SKIPPED);
    return;
  }

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

// Why the delayed initial request must not be sent, or null when it must. Attention flags
// (e.g. `phone_mismatch`) are deliberately ignored: such an order is still pending.
// A reminder claimed during the delay is checked separately (`getReminderDeliveryState`):
// only a reminder that actually reached the customer replaces the initial request (C5.18).
export const getInitialConfirmationSkipReason = (
  order: Pick<IOrder, 'customerConfirmationStatus' | 'shopifyCancelledAt' | 'operationalStatus'>
) => {
  if (order.customerConfirmationStatus !== CustomerConfirmationStatus.PENDING) {
    return 'not_pending';
  }

  if (order.shopifyCancelledAt) {
    return 'cancelled_on_shopify';
  }

  if (order.operationalStatus && TERMINAL_OPERATIONAL_STATUSES.includes(order.operationalStatus)) {
    return 'terminal_operational_status';
  }

  return null;
};

// C5.18: how many times the delayed initial request waits for a reminder still being sent.
// Past this bound the reminder is considered stuck (lost job, hung provider call) and the
// initial request is sent: the customer is never left without any request.
export const MAX_INITIAL_REQUEST_REMINDER_WAITS = 3;

// C5.18: a reminder is claimed on the order (`reminderCount`, `lastReminderAt`) before its
// Message is created. A claim this recent without any reminder Message is still being dispatched.
export const RECENT_REMINDER_CLAIM_MS = 2 * 60 * 1000;

type ReminderDeliveryState = 'reached' | 'in_progress' | 'none';

// Whether a reminder claimed for this order reached the customer, is still being sent (claimed
// moments ago, queued or retrying), or failed / never existed.
const getReminderDeliveryState = async (
  order: Pick<IOrder, '_id' | 'lastReminderAt'>
): Promise<ReminderDeliveryState> => {
  const reminders = await Message.find(
    { orderId: order._id, templatePurpose: TemplatePurpose.REMINDER },
    { status: 1 }
  );

  if (
    reminders.length === 0 &&
    order.lastReminderAt &&
    Date.now() - new Date(order.lastReminderAt).getTime() < RECENT_REMINDER_CLAIM_MS
  ) {
    return 'in_progress';
  }

  if (reminders.some(reminder => isMessageAlreadySent(reminder.status))) {
    return 'reached';
  }

  if (reminders.some(reminder => reminder.status === MessageStatus.QUEUED || reminder.status === MessageStatus.SENDING)) {
    return 'in_progress';
  }

  return 'none';
};

// Settles the initial request status of an order whose delayed request will never be sent.
// Conditional write: a status already set by the send flow is never overwritten.
const settlePendingInitialNotification = async (
  orderId: string,
  notificationStatus: NotificationStatus.SKIPPED | NotificationStatus.FAILED
) => {
  return Order.updateOne(
    { _id: orderId, notificationStatus: NotificationStatus.PENDING },
    { $set: { notificationStatus } }
  );
};

// C5.15: the scheduling timed out at ingestion (order flagged `notification_not_scheduled`) but a
// confirmation request did reach the customer afterwards (late delayed request handed over,
// reminder sent): the helpdesk must not take over a customer who has it. Conditional write: any
// other reason is left untouched. Never throws: a failure only leaves the flag for an agent.
const clearNotScheduledAttention = async (orderId: string, jobId?: string) => {
  try {
    await Order.updateOne(
      { _id: orderId, attentionReasonCode: AttentionReasonCode.NOTIFICATION_NOT_SCHEDULED },
      {
        $set: { needsHelpdeskAttention: false },
        $unset: { attentionReason: '', attentionReasonCode: '', attentionRequiredAt: '' }
      }
    );
  } catch (err) {
    log.error({ err, jobId, orderId }, 'Failed to clear notification_not_scheduled attention');
  }
};

// Delayed first confirmation request (C5.6a): runs once the configured delay has expired and
// hands over to the regular flow (same job, same worker, same SMS fallback) only when the
// order is still pending. It never touches `reminderCount`.
export const processInitialConfirmationRequest = async (job: Job<InitialConfirmationRequestJobData>) => {
  const { orderId } = job.data;
  const order = await Order.findById(orderId);

  if (!order) {
    log.warn({ jobId: job.id, orderId }, 'Order not found for delayed initial confirmation request, nothing sent');
    return;
  }

  let skipReason: string | null = getInitialConfirmationSkipReason(order);

  // C5.18: a reminder claimed during the delay replaces the initial request only once it
  // actually reached the customer. A failed one does not: the request (and its SMS fallback)
  // still goes out. One still being sent is waited for, a bounded number of times, so the
  // customer gets neither two requests nor none.
  if (!skipReason && (order.reminderCount || 0) > 0) {
    const reminderState = await getReminderDeliveryState(order);
    const reminderWaitCount = job.data.reminderWaitCount || 0;

    if (reminderState === 'reached') {
      skipReason = 'already_reminded';
    } else if (reminderState === 'in_progress' && reminderWaitCount < MAX_INITIAL_REQUEST_REMINDER_WAITS) {
      const postponedJob = await postponeInitialConfirmationRequest(orderId, reminderWaitCount + 1);
      log.info(
        { jobId: job.id, orderId, reminderWaitCount: reminderWaitCount + 1, postponedJobId: postponedJob.id },
        'Delayed initial confirmation request postponed, a reminder is still being sent'
      );
      return;
    } else if (reminderState === 'in_progress') {
      log.warn(
        { jobId: job.id, orderId, reminderWaitCount },
        'Reminder still not sent after the last wait, sending the delayed initial confirmation request'
      );
    }
  }

  if (skipReason) {
    log.info(
      {
        jobId: job.id,
        orderId,
        skipReason,
        customerConfirmationStatus: order.customerConfirmationStatus,
        operationalStatus: order.operationalStatus
      },
      'Delayed initial confirmation request skipped, order no longer pending'
    );
    await settlePendingInitialNotification(orderId, NotificationStatus.SKIPPED);
    // `notification_not_scheduled` stays: a reminder clears it only once it is actually sent
    // (processConfirmationReminder), never on a reminder that failed or is still retrying.
    return;
  }

  // Retry-safe: reuse the request a previous attempt created but could not hand over;
  // a request already picked by the send flow is never handed over twice.
  const existing = await Message.findOne({
    orderId: order._id,
    channel: MessageChannel.WHATSAPP,
    templatePurpose: TemplatePurpose.ORDER_CONFIRMATION_REQUEST
  });

  if (existing && existing.status !== MessageStatus.QUEUED) {
    log.info(
      { jobId: job.id, orderId, messageId: existing._id, status: existing.status },
      'Initial confirmation request already handed over, skipping duplicate job'
    );
    return;
  }

  const message =
    existing ||
    (await Message.create({
      orderId: order._id,
      channel: MessageChannel.WHATSAPP,
      provider: MessageProvider.META,
      status: MessageStatus.QUEUED,
      templateName: config.metaWhatsApp.templateName,
      templatePurpose: TemplatePurpose.ORDER_CONFIRMATION_REQUEST
    }));

  // Deterministic id: a replay of this job after the hand-over never adds a second send.
  const confirmationJob = await enqueueOrderConfirmation(
    {
      orderId: order._id.toString(),
      messageId: message._id.toString(),
      channel: MessageChannel.WHATSAPP
    },
    { jobId: getInitialConfirmationSendJobId(message._id.toString()) }
  );

  log.info(
    {
      jobId: job.id,
      orderId,
      messageId: message._id,
      confirmationJobId: confirmationJob.id
    },
    'Delayed initial confirmation request handed over to the send flow'
  );

  if (order.attentionReasonCode === AttentionReasonCode.NOTIFICATION_NOT_SCHEDULED) {
    await clearNotScheduledAttention(orderId, job.id);
  }

  return { messageId: message._id.toString(), confirmationJobId: confirmationJob.id };
};

const processOrderCancelled = async (job: Job<SendOrderConfirmationJobData>) => {
  const { result } = await sendMetaTemplate(job, config.metaWhatsApp.cancelledTemplateName, TemplatePurpose.ORDER_CANCELLED);

  return result;
};

const processOrderConfirmed = async (job: Job<SendOrderConfirmationJobData>) => {
  const { result } = await sendMetaTemplate(job, config.metaWhatsApp.confirmedTemplateName, TemplatePurpose.ORDER_CONFIRMED);

  return result;
};

// Notification statuses a successful reminder overrides: the customer did receive a request.
const NOTIFICATION_STATUSES_SET_BY_REMINDER = [
  NotificationStatus.PENDING,
  NotificationStatus.SKIPPED,
  NotificationStatus.FAILED
];

const processConfirmationReminder = async (job: Job<SendOrderConfirmationJobData>) => {
  const buttonPayload = createOrderConfirmationButtonPayload(job.data.orderId);
  const { result, skipReason } = await sendMetaTemplate(
    job,
    config.metaWhatsApp.templateName,
    TemplatePurpose.REMINDER,
    buttonPayload,
    { requireConfirmableOrder: true }
  );
  if (skipReason) {
    return;
  }

  // The reminder reached the customer: the agent no longer has to send one (C5.15).
  await clearNotScheduledAttention(job.data.orderId, job.id);

  // Conditional write: `sent` and `partially_sent` are never overwritten. The reminder is
  // already sent: a failure here must never fail the job (a replay would send it again).
  try {
    await Order.updateOne(
      { _id: job.data.orderId, notificationStatus: { $in: NOTIFICATION_STATUSES_SET_BY_REMINDER } },
      { $set: { notificationStatus: NotificationStatus.SENT } }
    );
  } catch (err) {
    log.error(
      { err, jobId: job.id, orderId: job.data.orderId, messageId: job.data.messageId },
      'Reminder sent but the order notification status could not be updated'
    );
  }

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

  if (isMessageAlreadySent(existingMessage?.status)) {
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

  // The order may have been confirmed, cancelled or closed during the WhatsApp attempts:
  // no SMS then, and the job ends normally.
  const skipReason = getConfirmationSendSkipReason(order);

  if (skipReason) {
    await markMessageAsNotSent(job, order, skipReason);
    await settlePendingInitialNotification(order._id.toString(), NotificationStatus.SKIPPED);
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

  // Conditional write: an order confirmed (or cancelled, closed) while the SMS was being sent
  // is never downgraded to `sms_only` nor sent back to the helpdesk queue.
  const downgraded = await Order.findOneAndUpdate(
    { ...STILL_CONFIRMABLE_FILTER, _id: order._id },
    {
      $set: {
        notificationStatus: NotificationStatus.PARTIALLY_SENT,
        customerConfirmationStatus: CustomerConfirmationStatus.SMS_ONLY,
        needsHelpdeskAttention: true,
        attentionReasonCode: AttentionReasonCode.SMS_ONLY,
        attentionReason: 'WhatsApp failed and the confirmation request was delivered by SMS',
        attentionRequiredAt: new Date()
      }
    },
    { new: true }
  );

  if (!downgraded) {
    await Order.findByIdAndUpdate(order._id, {
      $set: {
        notificationStatus: NotificationStatus.PARTIALLY_SENT
      }
    });
    log.info(
      { jobId: job.id, orderId: order._id, messageId: job.data.messageId },
      'SMS fallback sent but order no longer awaits confirmation; confirmation status left unchanged'
    );
  }

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

  // Confirmed, cancelled or closed during the WhatsApp attempts: no SMS Message is created.
  const skipReason = getConfirmationSendSkipReason(order);

  if (skipReason) {
    log.info(
      {
        orderId: order._id,
        whatsappMessageId: job.data.messageId,
        skipReason,
        customerConfirmationStatus: order.customerConfirmationStatus
      },
      'SMS fallback not created, order no longer awaits confirmation'
    );
    await settlePendingInitialNotification(order._id.toString(), NotificationStatus.SKIPPED);
    return;
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

  // The delayed initial job carries no Message: only the order's initial request status is
  // settled (the automatic reminders still apply).
  if (job.name === SEND_INITIAL_CONFIRMATION_REQUEST_JOB) {
    await settlePendingInitialNotification(orderId, NotificationStatus.FAILED);
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

        if (job.name === SEND_INITIAL_CONFIRMATION_REQUEST_JOB) {
          return processInitialConfirmationRequest(job as unknown as Job<InitialConfirmationRequestJobData>);
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
