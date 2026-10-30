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
  getRedisConnection: jest.fn()
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
import { enqueueOrderConfirmation } from '../queues/notification.queue';
import log from '../utilities/logger/logger';
import { MetaWhatsAppProvider } from '../providers/metaWhatsApp.provider';
import { ChatwootOutboundMirrorService } from '../utilities/services/chatwootOutboundMirror.service';
import { MessageVariableConfigService } from '../utilities/services/messageVariableConfig.service';
import {
  buildTemplateVariables,
  getOrderDeliveryRegion,
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
  let messageCreate: ReturnType<typeof jest.spyOn>;
  let orderWrites: ReturnType<typeof jest.spyOn>[];
  let orderUpdateOne: ReturnType<typeof jest.spyOn>;

  beforeAll(() => {
    startNotificationWorker();
  });

  beforeEach(() => {
    orderFindById = jest.spyOn(Order, 'findById').mockResolvedValue(storedOrder() as never);
    messageFindOne = jest.spyOn(Message, 'findOne').mockResolvedValue(null as never);
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
      expect(orderUpdateOne).toHaveBeenCalledTimes(1);
      expect(orderUpdateOne.mock.calls[0]).toEqual(clearNotScheduledCall);
    });

    it('keeps the reason when the reminder fails', async () => {
      sendTemplate.mockRejectedValue(new Error('Meta down') as never);

      await expect(mockWorkerRegistry.processor?.(reminderJob())).rejects.toThrow('Meta down');

      expect(orderUpdateOne).not.toHaveBeenCalled();
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
