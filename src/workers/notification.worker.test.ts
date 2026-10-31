import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';

// Captures the processor and event handlers registered by `startNotificationWorker`.
const mockWorkerRegistry: {
  processor?: (job: unknown) => Promise<unknown>;
  handlers: Record<string, (...args: unknown[]) => unknown>;
} = { handlers: {} };

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((...args: unknown[]) => {
    mockWorkerRegistry.processor = args[1] as (job: unknown) => Promise<unknown>;
    return {
      on: (event: string, handler: (...handlerArgs: unknown[]) => unknown) => {
        mockWorkerRegistry.handlers[event] = handler;
      },
      close: jest.fn()
    };
  })
}));

// The real pino logger writes through a pino-pretty worker thread that keeps Jest alive.
jest.mock('../utilities/logger/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

jest.mock('../queues/notification.queue', () => ({
  CONFIRMATION_SWEEP_JOB: 'confirmation-sweep',
  MAINTENANCE_QUEUE_NAME: 'maintenance',
  NOTIFICATION_QUEUE_NAME: 'notifications',
  SEND_CONFIRMATION_REMINDER_JOB: 'send-confirmation-reminder',
  SEND_INITIAL_CONFIRMATION_REQUEST_JOB: 'send-initial-confirmation-request',
  SEND_ORDER_CANCELLED_JOB: 'send-order-cancelled',
  SEND_ORDER_CONFIRMED_JOB: 'send-order-confirmed',
  SEND_ORDER_CONFIRMATION_JOB: 'send-order-confirmation',
  enqueueOrderConfirmation: jest.fn(),
  getInitialConfirmationSendJobId: (messageId: string) => `confirm-send-${messageId}`,
  getRedisConnection: jest.fn(),
  postponeInitialConfirmationRequest: jest.fn()
}));

jest.mock('../utilities/services/capiPurchase.service', () => ({
  triggerCapiPurchase: jest.fn(async () => undefined)
}));

import {
  AttentionReasonCode,
  CustomerConfirmationStatus,
  IOrder,
  NotificationStatus,
  Order,
  OrderOperationalStatus
} from '../models/Order';
import { Message, MessageChannel, MessageProvider, MessageStatus, TemplatePurpose } from '../models/Message';
import { MetaWhatsAppProvider } from '../providers/metaWhatsApp.provider';
import { TermiiSmsProvider } from '../providers/termiiSms.provider';
import { enqueueOrderConfirmation, postponeInitialConfirmationRequest } from '../queues/notification.queue';
import log from '../utilities/logger/logger';
import { ChatwootOutboundMirrorService } from '../utilities/services/chatwootOutboundMirror.service';
import { MessageVariableConfigService } from '../utilities/services/messageVariableConfig.service';
import {
  CONFIRMATION_REQUEST_ALREADY_SENT,
  ORDER_NO_LONGER_PENDING,
  buildTemplateVariables,
  getOrderDeliveryRegion,
  MAX_INITIAL_REQUEST_REMINDER_WAITS,
  RECENT_REMINDER_CLAIM_MS,
  processInitialConfirmationRequest,
  startNotificationWorker
} from './notification.worker';

const buildOrder = (overrides: Partial<IOrder> = {}) => {
  return {
    shopifyOrderName: '#1001',
    customerName: 'Isadore Mangala Ndoye',
    lineItems: [{ title: 'Produit test', quantity: 1 }],
    totalPrice: '25000.00',
    paymentGatewayNames: ['visa'],
    isCashOnDelivery: false,
    ...overrides
  } as IOrder;
};

describe('notification worker message variables', () => {
  it('resolves the immutable delivery region from the order snapshot first', () => {
    const order = buildOrder({
      deliveryRegionCode: 'SN_ZG',
      deliveryRegion: 'Ziguinchor',
      shippingRegion: 'Dakar'
    });

    expect(getOrderDeliveryRegion(order)).toBe('SN_ZG');
  });

  it('falls back to legacy shippingRegion for orders created before step 16', () => {
    expect(getOrderDeliveryRegion(buildOrder({ shippingRegion: 'Thiès' }))).toBe('Thiès');
  });

  it('never applies the configured COD payment text to a non-COD order', () => {
    const variables = buildTemplateVariables(
      buildOrder(),
      null,
      TemplatePurpose.ORDER_CONFIRMATION_REQUEST,
      { paymentMethod: 'Paiement à la livraison configuré' }
    );

    expect(variables.find(variable => variable.name === 'payment_method')?.value).toBe('visa');
  });

  it('applies the regional payment override to a COD order', () => {
    const variables = buildTemplateVariables(
      buildOrder({ isCashOnDelivery: true, paymentGatewayNames: ['Cash on Delivery (COD)'] }),
      null,
      TemplatePurpose.ORDER_CONFIRMATION_REQUEST,
      { paymentMethod: 'Paiement à la livraison configuré' }
    );

    expect(variables.find(variable => variable.name === 'payment_method')?.value).toBe(
      'Paiement à la livraison configuré'
    );
  });
});

const INITIAL_JOB = 'send-initial-confirmation-request';
const CONFIRMATION_JOB = 'send-order-confirmation';
const REMINDER_JOB = 'send-confirmation-reminder';

const flushPromises = async () => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
};

describe('delayed initial confirmation request (C5.6a)', () => {
  const orderId = new Types.ObjectId();
  const messageId = new Types.ObjectId();

  const storedOrder = (overrides: Record<string, unknown> = {}) => ({
    _id: orderId,
    customerConfirmationStatus: CustomerConfirmationStatus.PENDING,
    notificationStatus: NotificationStatus.PENDING,
    reminderCount: 0,
    customerPhoneE164: '+221776986780',
    ...overrides
  });

  const initialJob = () => ({ id: `confirm-initial-${orderId.toString()}`, name: INITIAL_JOB, data: { orderId: orderId.toString() } });

  let orderFindById: ReturnType<typeof jest.spyOn>;
  let messageFindOne: ReturnType<typeof jest.spyOn>;
  let messageFind: ReturnType<typeof jest.spyOn>;
  let messageCreate: ReturnType<typeof jest.spyOn>;
  let orderWrites: ReturnType<typeof jest.spyOn>[];
  let orderUpdateOne: ReturnType<typeof jest.spyOn>;

  beforeAll(() => {
    startNotificationWorker();
  });

  beforeEach(() => {
    orderFindById = jest.spyOn(Order, 'findById').mockResolvedValue(storedOrder() as never);
    messageFindOne = jest.spyOn(Message, 'findOne').mockResolvedValue(null as never);
    // Reminder Messages of the order (C5.18): none by default.
    messageFind = jest.spyOn(Message, 'find').mockResolvedValue([] as never);
    messageCreate = jest.spyOn(Message, 'create').mockResolvedValue({ _id: messageId } as never);
    orderWrites = [
      jest.spyOn(Order, 'findByIdAndUpdate').mockResolvedValue(null as never),
      jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue(null as never),
      jest.spyOn(Order, 'updateOne').mockResolvedValue({} as never),
      jest.spyOn(Order, 'updateMany').mockResolvedValue({} as never)
    ];
    orderUpdateOne = orderWrites[2];
    (enqueueOrderConfirmation as jest.Mock).mockResolvedValue({ id: 'send-1', queueName: 'notifications' } as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const expectHandedOver = () => {
    expect(messageCreate).toHaveBeenCalledTimes(1);
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId,
        channel: MessageChannel.WHATSAPP,
        provider: MessageProvider.META,
        status: MessageStatus.QUEUED,
        templatePurpose: TemplatePurpose.ORDER_CONFIRMATION_REQUEST
      })
    );
    expect(enqueueOrderConfirmation).toHaveBeenCalledTimes(1);
    expect(enqueueOrderConfirmation).toHaveBeenCalledWith(
      { orderId: orderId.toString(), messageId: messageId.toString(), channel: MessageChannel.WHATSAPP },
      { jobId: `confirm-send-${messageId.toString()}` }
    );
  };

  const expectInitialStatusSettledAs = (status: NotificationStatus) => {
    expect(orderUpdateOne).toHaveBeenCalledTimes(1);
    expect(orderUpdateOne).toHaveBeenCalledWith(
      { _id: orderId.toString(), notificationStatus: NotificationStatus.PENDING },
      { $set: { notificationStatus: status } }
    );
  };

  const expectNothingSent = () => {
    expect(messageCreate).not.toHaveBeenCalled();
    expect(enqueueOrderConfirmation).not.toHaveBeenCalled();
  };

  it('creates the Message and hands over to the existing send flow when the order is still pending', async () => {
    await processInitialConfirmationRequest(initialJob() as never);

    expectHandedOver();
    // reminderCount (and the order in general) is left untouched.
    for (const write of orderWrites) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it('is routed by the notification worker under its own job name', async () => {
    await mockWorkerRegistry.processor?.(initialJob());

    expectHandedOver();
  });

  it('still sends to a pending order flagged phone_mismatch', async () => {
    orderFindById.mockResolvedValue(
      storedOrder({
        needsHelpdeskAttention: true,
        attentionReasonCode: AttentionReasonCode.PHONE_MISMATCH,
        attentionReason: 'Pre-filled confirmation from another phone'
      }) as never
    );

    await processInitialConfirmationRequest(initialJob() as never);

    expectHandedOver();
  });

  it.each([
    ['confirmed before the delay', { customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED }],
    ['cancelled here', { customerConfirmationStatus: CustomerConfirmationStatus.CANCELLED }],
    ['expired', { customerConfirmationStatus: CustomerConfirmationStatus.EXPIRED }],
    ['needing attention', { customerConfirmationStatus: CustomerConfirmationStatus.NEEDS_ATTENTION }],
    ['cancelled on Shopify', { shopifyCancelledAt: new Date('2026-10-30T10:00:00.000Z') }],
    ['delivered', { operationalStatus: OrderOperationalStatus.DELIVERED }],
    ['returned', { operationalStatus: OrderOperationalStatus.RETURNED }],
    ['already reminded during the delay', { reminderCount: 1, lastReminderAt: new Date() }]
  ])('sends nothing, creates no Message and marks the request skipped for an order %s', async (_label, overrides) => {
    orderFindById.mockResolvedValue(storedOrder(overrides) as never);
    // Only read for the reminded order: its reminder reached the customer (C5.18).
    messageFind.mockResolvedValue([{ status: MessageStatus.DELIVERED }] as never);
    const logInfo = jest.spyOn(log, 'info');

    await processInitialConfirmationRequest(initialJob() as never);

    expectNothingSent();
    expectInitialStatusSettledAs(NotificationStatus.SKIPPED);
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: orderId.toString() }),
      'Delayed initial confirmation request skipped, order no longer pending'
    );
  });

  it('sends nothing when the order no longer exists', async () => {
    orderFindById.mockResolvedValue(null as never);

    await processInitialConfirmationRequest(initialJob() as never);

    expectNothingSent();
  });

  it('reuses the queued Message of a previous attempt that could not hand over', async () => {
    messageFindOne.mockResolvedValue({ _id: messageId, status: MessageStatus.QUEUED } as never);

    await processInitialConfirmationRequest(initialJob() as never);

    expect(messageCreate).not.toHaveBeenCalled();
    expect(enqueueOrderConfirmation).toHaveBeenCalledWith(
      { orderId: orderId.toString(), messageId: messageId.toString(), channel: MessageChannel.WHATSAPP },
      { jobId: `confirm-send-${messageId.toString()}` }
    );
  });

  it('hands over under the same send job id when replayed after the hand-over', async () => {
    await processInitialConfirmationRequest(initialJob() as never);
    // Replay: the Message created by the first run is still queued.
    messageFindOne.mockResolvedValue({ _id: messageId, status: MessageStatus.QUEUED } as never);
    await processInitialConfirmationRequest(initialJob() as never);

    const sendJobIds = (enqueueOrderConfirmation as jest.Mock).mock.calls.map(call => (call[1] as { jobId: string }).jobId);
    expect(sendJobIds).toEqual([`confirm-send-${messageId.toString()}`, `confirm-send-${messageId.toString()}`]);
    expect(messageCreate).toHaveBeenCalledTimes(1);
  });

  it('never hands over twice a request already picked by the send flow', async () => {
    messageFindOne.mockResolvedValue({ _id: messageId, status: MessageStatus.SENT } as never);

    await processInitialConfirmationRequest(initialJob() as never);

    expectNothingSent();
  });

  it('keeps the SMS fallback immediate after the WhatsApp request finally fails', async () => {
    const smsMessageId = new Types.ObjectId();
    jest.spyOn(Message, 'findByIdAndUpdate').mockResolvedValue(null as never);
    messageCreate.mockResolvedValue({ _id: smsMessageId } as never);
    const failedJob = {
      id: 'send-1',
      name: CONFIRMATION_JOB,
      data: { orderId: orderId.toString(), messageId: messageId.toString(), channel: MessageChannel.WHATSAPP },
      attemptsMade: 3,
      opts: { attempts: 3 }
    };

    mockWorkerRegistry.handlers.failed?.(failedJob, new Error('Meta down'));
    await flushPromises();

    expect(enqueueOrderConfirmation).toHaveBeenCalledTimes(1);
    const call = (enqueueOrderConfirmation as jest.Mock).mock.calls[0];
    expect(call).toEqual([
      { orderId: orderId.toString(), messageId: smsMessageId.toString(), channel: MessageChannel.SMS }
    ]);
  });

  it('marks the initial request failed, and nothing else, when the delayed job finally fails', async () => {
    const messageUpdate = jest.spyOn(Message, 'findByIdAndUpdate').mockResolvedValue(null as never);

    mockWorkerRegistry.handlers.failed?.(
      { ...initialJob(), attemptsMade: 3, opts: { attempts: 3 } },
      new Error('Redis down')
    );
    await flushPromises();

    expect(messageUpdate).not.toHaveBeenCalled();
    expectInitialStatusSettledAs(NotificationStatus.FAILED);
    for (const write of orderWrites.filter(write => write !== orderUpdateOne)) {
      expect(write).not.toHaveBeenCalled();
    }
    expect(enqueueOrderConfirmation).not.toHaveBeenCalled();
  });

  // C5.15: the scheduling timed out at ingestion, then the hung add landed after all.
  const notScheduledFlag = {
    notificationStatus: NotificationStatus.FAILED,
    needsHelpdeskAttention: true,
    attentionReasonCode: AttentionReasonCode.NOTIFICATION_NOT_SCHEDULED,
    attentionReason: 'Demande de confirmation non programmée',
    attentionRequiredAt: new Date('2026-10-30T10:00:00.000Z')
  };

  it('clears the notification_not_scheduled reason when the late request is handed over (C5.15)', async () => {
    orderFindById.mockResolvedValue(storedOrder(notScheduledFlag) as never);

    await processInitialConfirmationRequest(initialJob() as never);

    expectHandedOver();
    expect(orderUpdateOne).toHaveBeenCalledTimes(1);
    expect(orderUpdateOne.mock.calls[0]).toEqual([
      { _id: orderId.toString(), attentionReasonCode: AttentionReasonCode.NOTIFICATION_NOT_SCHEDULED },
      {
        $set: { needsHelpdeskAttention: false },
        $unset: { attentionReason: '', attentionReasonCode: '', attentionRequiredAt: '' }
      }
    ]);
    // Cleared only after the hand-over.
    expect((enqueueOrderConfirmation as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      orderUpdateOne.mock.invocationCallOrder[0] as number
    );
  });

  it('still hands over when clearing the notification_not_scheduled reason fails (C5.15)', async () => {
    orderFindById.mockResolvedValue(storedOrder(notScheduledFlag) as never);
    orderUpdateOne.mockRejectedValue(new Error('Mongo down') as never);

    await expect(processInitialConfirmationRequest(initialJob() as never)).resolves.toEqual(
      expect.objectContaining({ messageId: messageId.toString() })
    );

    expectHandedOver();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: orderId.toString() }),
      'Failed to clear notification_not_scheduled attention'
    );
  });

  it('keeps any other reason when the request is handed over (C5.15)', async () => {
    orderFindById.mockResolvedValue(
      storedOrder({
        needsHelpdeskAttention: true,
        attentionReasonCode: AttentionReasonCode.PHONE_MISMATCH,
        attentionReason: 'Pre-filled confirmation from another phone'
      }) as never
    );

    await processInitialConfirmationRequest(initialJob() as never);

    expectHandedOver();
    for (const write of orderWrites) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  const clearNotScheduledCall = [
    { _id: orderId.toString(), attentionReasonCode: AttentionReasonCode.NOTIFICATION_NOT_SCHEDULED },
    {
      $set: { needsHelpdeskAttention: false },
      $unset: { attentionReason: '', attentionReasonCode: '', attentionRequiredAt: '' }
    }
  ];

  it.each([
    ['already reminded (the reminder clears it only once sent)', { reminderCount: 1 }],
    ['confirmed', { customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED }],
    ['cancelled here', { customerConfirmationStatus: CustomerConfirmationStatus.CANCELLED }],
    ['expired', { customerConfirmationStatus: CustomerConfirmationStatus.EXPIRED }],
    ['cancelled on Shopify', { shopifyCancelledAt: new Date('2026-10-30T10:00:00.000Z') }],
    ['delivered', { operationalStatus: OrderOperationalStatus.DELIVERED }]
  ])('keeps the notification_not_scheduled reason when the late request is skipped for an order %s (C5.15)', async (_label, overrides) => {
    orderFindById.mockResolvedValue(storedOrder({ ...notScheduledFlag, ...overrides }) as never);
    // Only read for the reminded order: its reminder reached the customer (C5.18).
    messageFind.mockResolvedValue([{ status: MessageStatus.SENT }] as never);

    await processInitialConfirmationRequest(initialJob() as never);

    expectNothingSent();
    expectInitialStatusSettledAs(NotificationStatus.SKIPPED);
  });

  it('keeps the notification_not_scheduled reason when the request was already picked by the send flow (C5.15)', async () => {
    orderFindById.mockResolvedValue(storedOrder(notScheduledFlag) as never);
    messageFindOne.mockResolvedValue({ _id: messageId, status: MessageStatus.SENT } as never);

    await processInitialConfirmationRequest(initialJob() as never);

    expectNothingSent();
    expect(orderUpdateOne).not.toHaveBeenCalled();
  });

  describe('confirmation reminder (C5.15)', () => {
    const reminderJob = () => ({
      id: 'reminder-1',
      name: REMINDER_JOB,
      data: { orderId: orderId.toString(), messageId: messageId.toString(), channel: MessageChannel.WHATSAPP }
    });
    let sendTemplate: ReturnType<typeof jest.spyOn>;

    beforeEach(() => {
      orderFindById.mockResolvedValue({ ...buildOrder(), ...storedOrder(notScheduledFlag) } as never);
      jest.spyOn(Message, 'findById').mockResolvedValue(null as never);
      jest.spyOn(Message, 'findByIdAndUpdate').mockResolvedValue({ _id: messageId, attemptCount: 1 } as never);
      jest.spyOn(MessageVariableConfigService, 'resolveForRegion').mockResolvedValue({} as never);
      jest.spyOn(ChatwootOutboundMirrorService, 'mirrorTemplateMessage').mockResolvedValue(undefined as never);
      sendTemplate = jest
        .spyOn(MetaWhatsAppProvider.prototype, 'sendOrderConfirmation')
        .mockResolvedValue({ providerMessageId: 'wamid.reminder', response: {} } as never);
    });

    it('clears the notification_not_scheduled reason once the reminder is sent', async () => {
      await mockWorkerRegistry.processor?.(reminderJob());

      expect(sendTemplate).toHaveBeenCalledTimes(1);
      // The flag is cleared, then the Notification column moves to sent (C5.13).
      expect(orderUpdateOne).toHaveBeenCalledTimes(2);
      expect(orderUpdateOne.mock.calls[0]).toEqual(clearNotScheduledCall);
      expect(orderUpdateOne.mock.calls[1]?.[1]).toEqual({ $set: { notificationStatus: NotificationStatus.SENT } });
    });

    it('keeps the reason when the reminder fails', async () => {
      sendTemplate.mockRejectedValue(new Error('Meta down') as never);

      await expect(mockWorkerRegistry.processor?.(reminderJob())).rejects.toThrow('Meta down');

      expect(orderUpdateOne).not.toHaveBeenCalled();
    });

    it('keeps the reason when the reminder is skipped because the order is no longer confirmable', async () => {
      orderFindById.mockResolvedValue({
        ...buildOrder(),
        ...storedOrder({ ...notScheduledFlag, operationalStatus: OrderOperationalStatus.DELIVERED })
      } as never);
      jest.spyOn(Message, 'updateOne').mockResolvedValue({ matchedCount: 1, modifiedCount: 1 } as never);

      await mockWorkerRegistry.processor?.(reminderJob());

      expect(sendTemplate).not.toHaveBeenCalled();
      expect(orderUpdateOne).not.toHaveBeenCalledWith(...clearNotScheduledCall);
    });
  });

  it('leaves the initial request status alone while the delayed job will retry', async () => {
    mockWorkerRegistry.handlers.failed?.(
      { ...initialJob(), attemptsMade: 1, opts: { attempts: 3 } },
      new Error('Redis down')
    );
    await flushPromises();

    expect(orderUpdateOne).not.toHaveBeenCalled();
  });
});

describe('confirmation requests never sent to, nor downgrading, a confirmed order (C5.13)', () => {
  const orderId = new Types.ObjectId();
  const messageId = new Types.ObjectId();
  const smsMessageId = new Types.ObjectId();

  let order: Record<string, unknown>;
  let messages: Record<string, Record<string, unknown>>;
  let sendWhatsApp: ReturnType<typeof jest.spyOn>;
  let sendSms: ReturnType<typeof jest.spyOn>;

  // Evaluates the write filters with MongoDB semantics: `null` and `$nin` also match a
  // missing field.
  const matchesFilter = (doc: Record<string, unknown>, filter: Record<string, unknown>) =>
    Object.entries(filter).every(([key, condition]) => {
      const value = doc[key];

      if (condition === null) {
        return value === null || value === undefined;
      }

      if (condition && typeof condition === 'object' && !(condition instanceof Types.ObjectId)) {
        const ops = condition as { $in?: unknown[]; $nin?: unknown[] };

        if (ops.$in) {
          return ops.$in.includes(value);
        }

        return !(ops.$nin || []).includes(value ?? null);
      }

      return String(value) === String(condition);
    });

  const applyUpdate = (doc: Record<string, unknown>, update: Record<string, Record<string, unknown>>) => {
    Object.assign(doc, update.$set || {});

    for (const [key, increment] of Object.entries(update.$inc || {})) {
      doc[key] = ((doc[key] as number) || 0) + (increment as number);
    }
  };

  const job = (name: string, channel: MessageChannel, id = messageId, attemptsMade = 0) => ({
    id: `${name}-${id.toString()}`,
    name,
    data: { orderId: orderId.toString(), messageId: id.toString(), channel },
    attemptsMade,
    opts: { attempts: 3 }
  });

  const whatsAppRequestJob = (attemptsMade = 0) => job(CONFIRMATION_JOB, MessageChannel.WHATSAPP, messageId, attemptsMade);
  const smsFallbackJob = () => job(CONFIRMATION_JOB, MessageChannel.SMS, smsMessageId);
  const reminderJob = (attemptsMade = 0) => job(REMINDER_JOB, MessageChannel.WHATSAPP, messageId, attemptsMade);

  const confirmOrder = () =>
    Object.assign(order, {
      customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED,
      operationalStatus: OrderOperationalStatus.TO_DELIVER,
      needsHelpdeskAttention: false
    });

  const expectMessageNotSent = (id: Types.ObjectId) => {
    expect(messages[id.toString()]).toEqual(
      expect.objectContaining({ status: MessageStatus.FAILED, errorCode: ORDER_NO_LONGER_PENDING })
    );
  };

  beforeAll(() => {
    startNotificationWorker();
  });

  beforeEach(() => {
    order = {
      _id: orderId,
      shopifyOrderName: '#1001',
      customerName: 'Isadore Mangala Ndoye',
      customerPhoneE164: '+221776986780',
      lineItems: [{ title: 'Produit test', quantity: 1 }],
      totalPrice: '25000.00',
      currency: 'XOF',
      paymentGatewayNames: [],
      isCashOnDelivery: true,
      customerConfirmationStatus: CustomerConfirmationStatus.PENDING,
      notificationStatus: NotificationStatus.PENDING,
      needsHelpdeskAttention: false,
      reminderCount: 0
    };
    messages = {
      [messageId.toString()]: { _id: messageId, orderId, status: MessageStatus.QUEUED, attemptCount: 0 },
      [smsMessageId.toString()]: { _id: smsMessageId, orderId, status: MessageStatus.QUEUED, attemptCount: 0 }
    };

    jest.spyOn(Order, 'findById').mockImplementation((() => Promise.resolve({ ...order })) as never);
    jest.spyOn(Order, 'findByIdAndUpdate').mockImplementation(((_id: unknown, update: never) =>
      Promise.resolve().then(() => {
        applyUpdate(order, update);
        return { ...order };
      })) as never);
    jest.spyOn(Order, 'findOneAndUpdate').mockImplementation(((filter: Record<string, unknown>, update: never) =>
      Promise.resolve().then(() => {
        if (!matchesFilter(order, filter)) {
          return null;
        }
        applyUpdate(order, update);
        return { ...order };
      })) as never);
    jest.spyOn(Order, 'updateOne').mockImplementation(((filter: Record<string, unknown>, update: never) =>
      Promise.resolve().then(() => {
        const matched = matchesFilter(order, filter);
        if (matched) {
          applyUpdate(order, update);
        }
        return { matchedCount: matched ? 1 : 0 };
      })) as never);
    jest.spyOn(Message, 'findById').mockImplementation(((id: unknown) =>
      Promise.resolve(messages[String(id)] ? { ...messages[String(id)] } : null)) as never);
    jest.spyOn(Message, 'findByIdAndUpdate').mockImplementation(((id: unknown, update: never) =>
      Promise.resolve().then(() => {
        const message = messages[String(id)];
        applyUpdate(message, update);
        return { ...message };
      })) as never);
    jest.spyOn(Message, 'updateOne').mockImplementation(((filter: Record<string, unknown>, update: never) =>
      Promise.resolve().then(() => {
        const message = messages[String(filter._id)];
        const matched = Boolean(message && matchesFilter(message, { ...filter, _id: message._id }));
        if (matched) {
          applyUpdate(message, update);
        }
        return { matchedCount: matched ? 1 : 0 };
      })) as never);
    jest.spyOn(Message, 'create').mockResolvedValue({ _id: smsMessageId } as never);
    jest.spyOn(Message, 'find').mockImplementation(((filter: Record<string, unknown>) =>
      Promise.resolve(
        Object.values(messages)
          .filter(
            message =>
              String(message.orderId) === String(filter.orderId) && message.templatePurpose === filter.templatePurpose
          )
          .map(message => ({ ...message }))
      )) as never);
    jest.spyOn(MessageVariableConfigService, 'resolveForRegion').mockResolvedValue({} as never);
    jest.spyOn(ChatwootOutboundMirrorService, 'mirrorTemplateMessage').mockResolvedValue(true as never);
    sendWhatsApp = jest
      .spyOn(MetaWhatsAppProvider.prototype, 'sendOrderConfirmation')
      .mockResolvedValue({ providerMessageId: 'wamid.1', response: {} } as never);
    sendSms = jest
      .spyOn(TermiiSmsProvider.prototype, 'sendSms')
      .mockResolvedValue({ providerMessageId: 'termii-1', response: {} } as never);
    (enqueueOrderConfirmation as jest.Mock).mockResolvedValue({ id: 'sms-1', queueName: 'notifications' } as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('initial WhatsApp request', () => {
    it('sends nothing more, falls back to no SMS and keeps the order confirmed when confirmed between two attempts', async () => {
      sendWhatsApp.mockRejectedValueOnce(new Error('Meta down') as never);

      await expect(mockWorkerRegistry.processor?.(whatsAppRequestJob())).rejects.toThrow('Meta down');
      mockWorkerRegistry.handlers.failed?.(whatsAppRequestJob(1), new Error('Meta down'));
      await flushPromises();
      confirmOrder();

      // The retry ends normally: no further attempt and no SMS fallback.
      await expect(mockWorkerRegistry.processor?.(whatsAppRequestJob(1))).resolves.toBeUndefined();

      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendSms).not.toHaveBeenCalled();
      expect(enqueueOrderConfirmation).not.toHaveBeenCalled();
      expectMessageNotSent(messageId);
      expect(order.customerConfirmationStatus).toBe(CustomerConfirmationStatus.CONFIRMED);
      expect(order.needsHelpdeskAttention).toBe(false);
      expect(order.notificationStatus).toBe(NotificationStatus.SKIPPED);
    });

    it.each([
      ['cancelled here', { customerConfirmationStatus: CustomerConfirmationStatus.CANCELLED }],
      ['cancelled on Shopify', { shopifyCancelledAt: new Date('2026-10-30T10:00:00.000Z') }],
      ['delivered', { operationalStatus: OrderOperationalStatus.DELIVERED }],
      ['returned', { operationalStatus: OrderOperationalStatus.RETURNED }]
    ])('sends nothing to an order %s', async (_label, change) => {
      Object.assign(order, change);

      await mockWorkerRegistry.processor?.(whatsAppRequestJob());

      expect(sendWhatsApp).not.toHaveBeenCalled();
      expectMessageNotSent(messageId);
    });

    it('still sends the request to an order awaiting confirmation', async () => {
      await mockWorkerRegistry.processor?.(whatsAppRequestJob());

      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(messages[messageId.toString()].status).toBe(MessageStatus.SENT);
      expect(order.notificationStatus).toBe(NotificationStatus.SENT);
      expect(order.customerConfirmationStatus).toBe(CustomerConfirmationStatus.PENDING);
    });

    it('still falls back to SMS when the request finally fails for an order awaiting confirmation', async () => {
      mockWorkerRegistry.handlers.failed?.(whatsAppRequestJob(3), new Error('Meta down'));
      await flushPromises();

      expect(enqueueOrderConfirmation).toHaveBeenCalledWith({
        orderId: orderId.toString(),
        messageId: smsMessageId.toString(),
        channel: MessageChannel.SMS
      });
    });
  });

  describe('SMS fallback', () => {
    it('sends no SMS and writes no sms_only when the order was confirmed during the WhatsApp attempts', async () => {
      confirmOrder();

      await expect(mockWorkerRegistry.processor?.(smsFallbackJob())).resolves.toBeUndefined();

      expect(sendSms).not.toHaveBeenCalled();
      expectMessageNotSent(smsMessageId);
      expect(order.customerConfirmationStatus).toBe(CustomerConfirmationStatus.CONFIRMED);
      expect(order.needsHelpdeskAttention).toBe(false);
      expect(order.attentionReasonCode).toBeUndefined();
      expect(order.notificationStatus).toBe(NotificationStatus.SKIPPED);
    });

    it.each([
      ['cancelled on Shopify', { shopifyCancelledAt: new Date('2026-10-30T10:00:00.000Z') }],
      ['delivered', { operationalStatus: OrderOperationalStatus.DELIVERED }],
      ['returned', { operationalStatus: OrderOperationalStatus.RETURNED }]
    ])('never downgrades to sms_only an order %s while the SMS was being sent', async (_label, change) => {
      sendSms.mockImplementation((() => {
        Object.assign(order, change);
        return Promise.resolve({ providerMessageId: 'termii-1', response: {} });
      }) as never);

      await mockWorkerRegistry.processor?.(smsFallbackJob());

      expect(sendSms).toHaveBeenCalledTimes(1);
      expect(order.customerConfirmationStatus).toBe(CustomerConfirmationStatus.PENDING);
      expect(order.needsHelpdeskAttention).toBe(false);
      expect(order.attentionReasonCode).toBeUndefined();
      expect(order.notificationStatus).toBe(NotificationStatus.PARTIALLY_SENT);
    });

    it('creates no SMS Message when the order was confirmed before the WhatsApp request finally failed', async () => {
      confirmOrder();

      mockWorkerRegistry.handlers.failed?.(whatsAppRequestJob(3), new Error('Meta down'));
      await flushPromises();

      expect(Message.create).not.toHaveBeenCalled();
      expect(enqueueOrderConfirmation).not.toHaveBeenCalled();
      expect(messages[messageId.toString()].status).toBe(MessageStatus.FAILED);
      expect(order.customerConfirmationStatus).toBe(CustomerConfirmationStatus.CONFIRMED);
      expect(order.notificationStatus).toBe(NotificationStatus.SKIPPED);
    });

    it('never downgrades to sms_only an order confirmed while the SMS was being sent', async () => {
      sendSms.mockImplementation((() => {
        confirmOrder();
        return Promise.resolve({ providerMessageId: 'termii-1', response: {} });
      }) as never);

      await mockWorkerRegistry.processor?.(smsFallbackJob());

      expect(sendSms).toHaveBeenCalledTimes(1);
      expect(messages[smsMessageId.toString()].status).toBe(MessageStatus.SENT);
      expect(order.customerConfirmationStatus).toBe(CustomerConfirmationStatus.CONFIRMED);
      expect(order.needsHelpdeskAttention).toBe(false);
      expect(order.attentionReasonCode).toBeUndefined();
      expect(order.notificationStatus).toBe(NotificationStatus.PARTIALLY_SENT);
    });

    it('still sends the SMS and flags sms_only for an order awaiting confirmation', async () => {
      await mockWorkerRegistry.processor?.(smsFallbackJob());

      expect(sendSms).toHaveBeenCalledTimes(1);
      expect(messages[smsMessageId.toString()].status).toBe(MessageStatus.SENT);
      expect(order).toEqual(
        expect.objectContaining({
          customerConfirmationStatus: CustomerConfirmationStatus.SMS_ONLY,
          notificationStatus: NotificationStatus.PARTIALLY_SENT,
          needsHelpdeskAttention: true,
          attentionReasonCode: AttentionReasonCode.SMS_ONLY
        })
      );
    });
  });

  describe('reminders', () => {
    it.each([
      ['confirmed', { customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED }],
      ['cancelled on Shopify', { shopifyCancelledAt: new Date('2026-10-30T10:00:00.000Z') }],
      ['delivered', { operationalStatus: OrderOperationalStatus.DELIVERED }],
      ['returned', { operationalStatus: OrderOperationalStatus.RETURNED }]
    ])('sends nothing to an order %s since the reminder was claimed', async (_label, change) => {
      Object.assign(order, { notificationStatus: NotificationStatus.SKIPPED }, change);

      await expect(mockWorkerRegistry.processor?.(reminderJob())).resolves.toBeUndefined();

      expect(sendWhatsApp).not.toHaveBeenCalled();
      expectMessageNotSent(messageId);
      expect(order.notificationStatus).toBe(NotificationStatus.SKIPPED);
    });

    it.each([NotificationStatus.PENDING, NotificationStatus.SKIPPED, NotificationStatus.FAILED])(
      'marks the notification sent after a successful reminder (from %s)',
      async notificationStatus => {
        order.notificationStatus = notificationStatus;

        await mockWorkerRegistry.processor?.(reminderJob());

        expect(sendWhatsApp).toHaveBeenCalledTimes(1);
        expect(order.notificationStatus).toBe(NotificationStatus.SENT);
      }
    );

    it('never overwrites a partially_sent notification after a successful reminder', async () => {
      order.notificationStatus = NotificationStatus.PARTIALLY_SENT;

      await mockWorkerRegistry.processor?.(reminderJob());

      expect(order.notificationStatus).toBe(NotificationStatus.PARTIALLY_SENT);
    });

    it('leaves the notification status unchanged when the reminder fails', async () => {
      order.notificationStatus = NotificationStatus.SKIPPED;
      sendWhatsApp.mockRejectedValue(new Error('Meta down') as never);

      await expect(mockWorkerRegistry.processor?.(reminderJob())).rejects.toThrow('Meta down');
      mockWorkerRegistry.handlers.failed?.(reminderJob(3), new Error('Meta down'));
      await flushPromises();

      expect(order.notificationStatus).toBe(NotificationStatus.SKIPPED);
      expect(messages[messageId.toString()].status).toBe(MessageStatus.FAILED);
    });

    it('keeps the notification sent when the delayed initial job runs after an agent reminder', async () => {
      // The agent reminder was claimed during the delay (reminderCount 1), then sent.
      order.reminderCount = 1;
      await mockWorkerRegistry.processor?.(reminderJob());
      expect(order.notificationStatus).toBe(NotificationStatus.SENT);

      await mockWorkerRegistry.processor?.({
        id: `confirm-initial-${orderId.toString()}`,
        name: INITIAL_JOB,
        data: { orderId: orderId.toString() }
      });

      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(order.notificationStatus).toBe(NotificationStatus.SENT);
    });
  });

  describe('replays and retries', () => {
    it('never sends a reminder twice when the status write fails after the send', async () => {
      // Only the Notification status write fails (the C5.15 flag clearing runs first).
      const isStatusWrite = (update: unknown) =>
        (update as { $set?: Record<string, unknown> })?.$set?.notificationStatus !== undefined;
      const updateOne = jest
        .spyOn(Order, 'updateOne')
        .mockImplementationOnce((() => Promise.resolve({ matchedCount: 0, modifiedCount: 0 })) as never)
        .mockImplementationOnce(((_filter: unknown, update: unknown) =>
          isStatusWrite(update) ? Promise.reject(new Error('Mongo blip')) : Promise.resolve({})) as never);

      await expect(mockWorkerRegistry.processor?.(reminderJob())).resolves.not.toThrow();
      expect(updateOne).toHaveBeenCalledTimes(2);
      expect(isStatusWrite(updateOne.mock.calls[1]?.[1])).toBe(true);
      expect(messages[messageId.toString()].status).toBe(MessageStatus.SENT);

      // The status webhook moved the message on before any replay.
      messages[messageId.toString()].status = MessageStatus.DELIVERED;
      await mockWorkerRegistry.processor?.(reminderJob());

      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    });

    it.each([MessageStatus.SENT, MessageStatus.DELIVERED, MessageStatus.READ])(
      'never sends again nor rewrites a %s message replayed on an order confirmed since',
      async status => {
        messages[messageId.toString()].status = status;
        confirmOrder();

        await mockWorkerRegistry.processor?.(reminderJob());
        await mockWorkerRegistry.processor?.(whatsAppRequestJob());

        expect(sendWhatsApp).not.toHaveBeenCalled();
        expect(messages[messageId.toString()].status).toBe(status);
        expect(messages[messageId.toString()].errorCode).toBeUndefined();
      }
    );

    it('never sends the initial request twice when replayed after delivery', async () => {
      messages[messageId.toString()].status = MessageStatus.DELIVERED;

      await mockWorkerRegistry.processor?.(whatsAppRequestJob());

      expect(sendWhatsApp).not.toHaveBeenCalled();
      expect(messages[messageId.toString()].status).toBe(MessageStatus.DELIVERED);
    });

    it('closes explicitly a retried initial request once a reminder already reached the customer', async () => {
      // Manual retry of a failed initial request: the controller re-queued the Message.
      order.notificationStatus = NotificationStatus.SENT;

      await expect(mockWorkerRegistry.processor?.(whatsAppRequestJob())).resolves.toBeUndefined();

      expect(sendWhatsApp).not.toHaveBeenCalled();
      expect(messages[messageId.toString()]).toEqual(
        expect.objectContaining({ status: MessageStatus.FAILED, errorCode: CONFIRMATION_REQUEST_ALREADY_SENT })
      );
    });

    it('leaves untouched an initial request already sent when its job is replayed', async () => {
      order.notificationStatus = NotificationStatus.SENT;
      messages[messageId.toString()].status = MessageStatus.SENT;

      await mockWorkerRegistry.processor?.(whatsAppRequestJob());

      expect(messages[messageId.toString()].status).toBe(MessageStatus.SENT);
      expect(messages[messageId.toString()].errorCode).toBeUndefined();
    });
  });

  // C5.18: an agent reminded the order during the delay; the delayed initial request (T+5) is
  // skipped only when that reminder actually reached the customer.
  describe('delayed initial request after an agent reminder (C5.18)', () => {
    const initialRequestId = new Types.ObjectId();
    const initialJob = (reminderWaitCount?: number) => ({
      id: `confirm-initial-${orderId.toString()}`,
      name: INITIAL_JOB,
      data: reminderWaitCount ? { orderId: orderId.toString(), reminderWaitCount } : { orderId: orderId.toString() }
    });

    beforeEach(() => {
      // The agent clicked "Relancer" before T+5: reminder claimed, its Message queued.
      order.reminderCount = 1;
      messages[messageId.toString()].templatePurpose = TemplatePurpose.REMINDER;
      jest.spyOn(Message, 'findOne').mockResolvedValue(null as never);
      jest.spyOn(Message, 'create').mockImplementation(((doc: Record<string, unknown>) => {
        const id = doc.channel === MessageChannel.SMS ? smsMessageId : initialRequestId;
        messages[id.toString()] = { ...doc, _id: id, attemptCount: 0 };
        return Promise.resolve({ _id: id });
      }) as never);
      (enqueueOrderConfirmation as jest.Mock).mockImplementation(((data: { messageId: string }) =>
        Promise.resolve({ id: `job-${data.messageId}` })) as never);
      (postponeInitialConfirmationRequest as jest.Mock).mockResolvedValue({ id: 'postponed-1' } as never);
    });

    const failReminderPermanently = async () => {
      sendWhatsApp.mockRejectedValueOnce(new Error('Meta down') as never);
      await expect(mockWorkerRegistry.processor?.(reminderJob())).rejects.toThrow('Meta down');
      mockWorkerRegistry.handlers.failed?.(reminderJob(3), new Error('Meta down'));
      await flushPromises();
      expect(messages[messageId.toString()].status).toBe(MessageStatus.FAILED);
    };

    it('skips the initial request once the reminder reached the customer', async () => {
      await mockWorkerRegistry.processor?.(reminderJob());
      await mockWorkerRegistry.processor?.(initialJob());

      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(Message.create).not.toHaveBeenCalled();
      expect(enqueueOrderConfirmation).not.toHaveBeenCalled();
      expect(postponeInitialConfirmationRequest).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: orderId.toString(), skipReason: 'already_reminded' }),
        'Delayed initial confirmation request skipped, order no longer pending'
      );
      expect(order.notificationStatus).toBe(NotificationStatus.SENT);
    });

    it.each([MessageStatus.DELIVERED, MessageStatus.READ])(
      'skips the initial request when the reminder is already %s',
      async status => {
        Object.assign(messages[messageId.toString()], { status });

        await mockWorkerRegistry.processor?.(initialJob());

        expect(enqueueOrderConfirmation).not.toHaveBeenCalled();
        expect(order.notificationStatus).toBe(NotificationStatus.SKIPPED);
      }
    );

    it('still sends the initial request, then its SMS fallback, when the reminder failed', async () => {
      await failReminderPermanently();

      await mockWorkerRegistry.processor?.(initialJob());

      expect(enqueueOrderConfirmation).toHaveBeenCalledWith(
        { orderId: orderId.toString(), messageId: initialRequestId.toString(), channel: MessageChannel.WHATSAPP },
        { jobId: `confirm-send-${initialRequestId.toString()}` }
      );

      // The WhatsApp request fails as well: the SMS fallback of the initial request applies.
      const requestJob = job(CONFIRMATION_JOB, MessageChannel.WHATSAPP, initialRequestId, 0);
      sendWhatsApp.mockRejectedValue(new Error('Meta down') as never);
      await expect(mockWorkerRegistry.processor?.(requestJob)).rejects.toThrow('Meta down');
      mockWorkerRegistry.handlers.failed?.({ ...requestJob, attemptsMade: 3 }, new Error('Meta down'));
      await flushPromises();

      expect(enqueueOrderConfirmation).toHaveBeenLastCalledWith({
        orderId: orderId.toString(),
        messageId: smsMessageId.toString(),
        channel: MessageChannel.SMS
      });

      await mockWorkerRegistry.processor?.(smsFallbackJob());

      expect(sendSms).toHaveBeenCalledTimes(1);
      expect(order).toEqual(
        expect.objectContaining({
          customerConfirmationStatus: CustomerConfirmationStatus.SMS_ONLY,
          notificationStatus: NotificationStatus.PARTIALLY_SENT,
          attentionReasonCode: AttentionReasonCode.SMS_ONLY,
          reminderCount: 1
        })
      );
    });

    it('sends the initial request normally when the reminder failed and WhatsApp works', async () => {
      await failReminderPermanently();

      await mockWorkerRegistry.processor?.(initialJob());
      await mockWorkerRegistry.processor?.(job(CONFIRMATION_JOB, MessageChannel.WHATSAPP, initialRequestId));

      expect(sendWhatsApp).toHaveBeenCalledTimes(2);
      expect(messages[initialRequestId.toString()].status).toBe(MessageStatus.SENT);
      expect(order.notificationStatus).toBe(NotificationStatus.SENT);
      expect(sendSms).not.toHaveBeenCalled();
    });

    it.each([MessageStatus.QUEUED, MessageStatus.SENDING])(
      'waits, without sending, for a reminder still %s, then skips once the reminder is sent',
      async status => {
        Object.assign(messages[messageId.toString()], { status });

        await mockWorkerRegistry.processor?.(initialJob());
        // Replayed: the same deterministic postponement, never a second one.
        await mockWorkerRegistry.processor?.(initialJob());

        expect(postponeInitialConfirmationRequest).toHaveBeenCalledTimes(2);
        expect((postponeInitialConfirmationRequest as jest.Mock).mock.calls).toEqual([
          [orderId.toString(), 1],
          [orderId.toString(), 1]
        ]);
        expect(Message.create).not.toHaveBeenCalled();
        expect(enqueueOrderConfirmation).not.toHaveBeenCalled();
        expect(order.notificationStatus).toBe(NotificationStatus.PENDING);

        // The reminder goes out, then the postponed request runs: nothing more is sent.
        messages[messageId.toString()].status = MessageStatus.QUEUED;
        await mockWorkerRegistry.processor?.(reminderJob());
        await mockWorkerRegistry.processor?.(initialJob(1));

        expect(sendWhatsApp).toHaveBeenCalledTimes(1);
        expect(Message.create).not.toHaveBeenCalled();
        expect(enqueueOrderConfirmation).not.toHaveBeenCalled();
        expect(postponeInitialConfirmationRequest).toHaveBeenCalledTimes(2);
      }
    );

    it('sends the postponed request when the reminder it waited for finally failed', async () => {
      Object.assign(messages[messageId.toString()], { status: MessageStatus.SENDING });
      await mockWorkerRegistry.processor?.(initialJob());
      expect(postponeInitialConfirmationRequest).toHaveBeenCalledWith(orderId.toString(), 1);

      mockWorkerRegistry.handlers.failed?.(reminderJob(3), new Error('Meta down'));
      await flushPromises();
      await mockWorkerRegistry.processor?.(initialJob(1));

      expect(postponeInitialConfirmationRequest).toHaveBeenCalledTimes(1);
      expect(enqueueOrderConfirmation).toHaveBeenCalledTimes(1);
      expect(enqueueOrderConfirmation).toHaveBeenCalledWith(
        { orderId: orderId.toString(), messageId: initialRequestId.toString(), channel: MessageChannel.WHATSAPP },
        { jobId: `confirm-send-${initialRequestId.toString()}` }
      );
    });

    it('waits a bounded number of times, then sends the request rather than leaving the customer without one', async () => {
      Object.assign(messages[messageId.toString()], { status: MessageStatus.SENDING });

      for (let wait = 0; wait < MAX_INITIAL_REQUEST_REMINDER_WAITS; wait += 1) {
        await mockWorkerRegistry.processor?.(initialJob(wait));
        expect(postponeInitialConfirmationRequest).toHaveBeenLastCalledWith(orderId.toString(), wait + 1);
      }
      expect(enqueueOrderConfirmation).not.toHaveBeenCalled();

      await mockWorkerRegistry.processor?.(initialJob(MAX_INITIAL_REQUEST_REMINDER_WAITS));

      expect(postponeInitialConfirmationRequest).toHaveBeenCalledTimes(MAX_INITIAL_REQUEST_REMINDER_WAITS);
      expect(enqueueOrderConfirmation).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: orderId.toString(), reminderWaitCount: MAX_INITIAL_REQUEST_REMINDER_WAITS }),
        'Reminder still not sent after the last wait, sending the delayed initial confirmation request'
      );
    });

    const expectHandedOverOnce = () => {
      expect(postponeInitialConfirmationRequest).not.toHaveBeenCalled();
      expect(enqueueOrderConfirmation).toHaveBeenCalledTimes(1);
      expect(enqueueOrderConfirmation).toHaveBeenCalledWith(
        { orderId: orderId.toString(), messageId: initialRequestId.toString(), channel: MessageChannel.WHATSAPP },
        { jobId: `confirm-send-${initialRequestId.toString()}` }
      );
    };

    const expectSkipped = () => {
      expect(postponeInitialConfirmationRequest).not.toHaveBeenCalled();
      expect(Message.create).not.toHaveBeenCalled();
      expect(enqueueOrderConfirmation).not.toHaveBeenCalled();
      expect(order.notificationStatus).toBe(NotificationStatus.SKIPPED);
    };

    it('ignores a reminder sent for another order of the same customer', async () => {
      const otherReminderId = new Types.ObjectId();
      Object.assign(messages[messageId.toString()], { status: MessageStatus.FAILED });
      messages[otherReminderId.toString()] = {
        _id: otherReminderId,
        orderId: new Types.ObjectId(),
        templatePurpose: TemplatePurpose.REMINDER,
        status: MessageStatus.SENT
      };

      await mockWorkerRegistry.processor?.(initialJob());

      expectHandedOverOnce();
      expect(Message.find).toHaveBeenCalledWith(
        expect.objectContaining({ orderId, templatePurpose: TemplatePurpose.REMINDER }),
        expect.anything()
      );
    });

    // Several reminders of this order (agent reminder, then the 24 h one): any of them that
    // reached the customer wins over one that failed or is still being sent.
    const addSecondReminder = (status: MessageStatus) => {
      const secondReminderId = new Types.ObjectId();
      messages[secondReminderId.toString()] = {
        _id: secondReminderId,
        orderId,
        templatePurpose: TemplatePurpose.REMINDER,
        status
      };
      return secondReminderId;
    };

    it.each([
      ['failed, then sent', MessageStatus.FAILED, MessageStatus.SENT],
      ['sent, then failed', MessageStatus.SENT, MessageStatus.FAILED],
      ['sent, then still queued', MessageStatus.SENT, MessageStatus.QUEUED],
      ['still sending, then delivered', MessageStatus.SENDING, MessageStatus.DELIVERED]
    ])('skips the initial request when the reminders were %s', async (_label, first, second) => {
      Object.assign(messages[messageId.toString()], { status: first });
      addSecondReminder(second);

      await mockWorkerRegistry.processor?.(initialJob());

      expectSkipped();
    });

    it('waits for a second reminder still being sent after a failed one, then sends once it failed too', async () => {
      Object.assign(messages[messageId.toString()], { status: MessageStatus.FAILED });
      const secondReminderId = addSecondReminder(MessageStatus.SENDING);

      await mockWorkerRegistry.processor?.(initialJob());

      expect(postponeInitialConfirmationRequest).toHaveBeenCalledWith(orderId.toString(), 1);
      expect(enqueueOrderConfirmation).not.toHaveBeenCalled();

      messages[secondReminderId.toString()].status = MessageStatus.FAILED;
      await mockWorkerRegistry.processor?.(initialJob(1));

      expect(postponeInitialConfirmationRequest).toHaveBeenCalledTimes(1);
      expect(enqueueOrderConfirmation).toHaveBeenCalledTimes(1);
    });

    describe('reminder claimed but its Message not created yet', () => {
      beforeEach(() => {
        // The claim (reminderCount, lastReminderAt) is written before the reminder Message.
        delete messages[messageId.toString()];
      });

      it('waits for a reminder claimed moments ago, then skips once it is sent', async () => {
        order.lastReminderAt = new Date(Date.now() - 30 * 1000);

        await mockWorkerRegistry.processor?.(initialJob());

        expect(postponeInitialConfirmationRequest).toHaveBeenCalledWith(orderId.toString(), 1);
        expect(Message.create).not.toHaveBeenCalled();
        expect(enqueueOrderConfirmation).not.toHaveBeenCalled();

        // The reminder Message is created and sent before the postponed request runs.
        messages[messageId.toString()] = {
          _id: messageId,
          orderId,
          templatePurpose: TemplatePurpose.REMINDER,
          status: MessageStatus.SENT
        };
        await mockWorkerRegistry.processor?.(initialJob(1));

        expect(postponeInitialConfirmationRequest).toHaveBeenCalledTimes(1);
        expect(enqueueOrderConfirmation).not.toHaveBeenCalled();
      });

      it('sends the request when an older claim never produced a reminder Message', async () => {
        order.lastReminderAt = new Date(Date.now() - RECENT_REMINDER_CLAIM_MS - 60 * 1000);

        await mockWorkerRegistry.processor?.(initialJob());

        expectHandedOverOnce();
      });

      it('sends the request when no claim date is recorded', async () => {
        await mockWorkerRegistry.processor?.(initialJob());

        expectHandedOverOnce();
      });
    });

    it('never looks for a reminder when the order was not reminded', async () => {
      order.reminderCount = 0;

      await mockWorkerRegistry.processor?.(initialJob());

      expect(Message.find).not.toHaveBeenCalled();
      expect(postponeInitialConfirmationRequest).not.toHaveBeenCalled();
      expect(enqueueOrderConfirmation).toHaveBeenCalledTimes(1);
    });

    it('still skips a request whose order was confirmed meanwhile, whatever the reminder state', async () => {
      Object.assign(messages[messageId.toString()], { status: MessageStatus.SENDING });
      confirmOrder();

      await mockWorkerRegistry.processor?.(initialJob());

      expect(postponeInitialConfirmationRequest).not.toHaveBeenCalled();
      expect(enqueueOrderConfirmation).not.toHaveBeenCalled();
      expect(Message.create).not.toHaveBeenCalled();
      expect(order.notificationStatus).toBe(NotificationStatus.SKIPPED);
      expect(order.customerConfirmationStatus).toBe(CustomerConfirmationStatus.CONFIRMED);
    });
  });

  describe('orders still confirmable without being pending', () => {
    it.each([CustomerConfirmationStatus.NEEDS_ATTENTION, CustomerConfirmationStatus.SMS_ONLY])(
      'still sends the initial request, the reminder and the SMS to an order %s',
      async status => {
        order.customerConfirmationStatus = status;

        await mockWorkerRegistry.processor?.(whatsAppRequestJob());
        messages[messageId.toString()].status = MessageStatus.QUEUED;
        await mockWorkerRegistry.processor?.(reminderJob());
        await mockWorkerRegistry.processor?.(smsFallbackJob());

        expect(sendWhatsApp).toHaveBeenCalledTimes(2);
        expect(sendSms).toHaveBeenCalledTimes(1);
        expect(order.customerConfirmationStatus).toBe(CustomerConfirmationStatus.SMS_ONLY);
      }
    );
  });
});
