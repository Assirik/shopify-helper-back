import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { InboundWhatsAppEvent, InboundWhatsAppEventStatus } from '../models/InboundWhatsAppEvent';
import { Message } from '../models/Message';
import {
  AttentionReasonCode,
  ConfirmationSource,
  CustomerConfirmationStatus,
  Order
} from '../models/Order';
import { OrderEvent, OrderEventType } from '../models/OrderEvent';
import { enqueueOrderConfirmed } from '../queues/notification.queue';
import log from '../utilities/logger/logger';
import { triggerCapiPurchase } from '../utilities/services/capiPurchase.service';
import { ChatwootForwardService } from '../utilities/services/chatwootForward.service';
import { OrderConfirmationService } from '../utilities/services/orderConfirmation.service';
import { WhatsAppWebhookController } from './whatsappWebhook.controller';

jest.mock('../queues/notification.queue', () => ({
  enqueueConfirmationReminder: jest.fn(),
  enqueueOrderCancelled: jest.fn(),
  enqueueOrderConfirmed: jest.fn()
}));

jest.mock('../utilities/services/capiPurchase.service', () => ({
  triggerCapiPurchase: jest.fn(async () => undefined)
}));

const ORDER_PHONE = '+221776986780';
const OTHER_SENDER = '221771112233';

const mockResponse = () => {
  const json = jest.fn((_body: unknown) => undefined);
  const status = jest.fn((_code: number) => ({ json }));
  return { res: { status } as unknown as Response, status, json };
};

const webhookRequest = (message: Record<string, unknown>) =>
  ({
    body: {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { messages: [{ id: 'wamid.in.1', ...message }] } }] }]
    }
  }) as unknown as Request;

const textMessage = (from: string, body: string) => ({ from, type: 'text', text: { body } });

// `Order.findOne` serves two lookups: by `shopifyOrderName` (pre-filled confirmation) and
// by `customerPhoneE164` followed by `.sort()` (regular reaction handling).
const mockOrderLookups = (order: Record<string, unknown>) =>
  jest.spyOn(Order, 'findOne').mockImplementation(((filter: Record<string, unknown>) => {
    if ('shopifyOrderName' in filter) {
      return Promise.resolve(filter.shopifyOrderName === order.shopifyOrderName ? order : null);
    }

    const result = filter.customerPhoneE164 === order.customerPhoneE164 ? order : null;
    return { sort: () => Promise.resolve(result) };
  }) as never);

describe('WhatsApp webhook: pre-filled confirmation (C5.6b)', () => {
  const orderId = new Types.ObjectId();
  let order: Record<string, unknown>;
  let forward: ReturnType<typeof jest.spyOn>;
  let createInbound: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    order = {
      _id: orderId,
      shopifyOrderName: '#1234',
      customerPhoneE164: ORDER_PHONE,
      customerConfirmationStatus: CustomerConfirmationStatus.PENDING
    };
    jest.spyOn(InboundWhatsAppEvent, 'exists').mockResolvedValue(null as never);
    createInbound = jest.spyOn(InboundWhatsAppEvent, 'create').mockResolvedValue({} as never);
    forward = jest.spyOn(ChatwootForwardService, 'forwardWhatsAppPayload').mockResolvedValue(true as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const inboundEvent = () => createInbound.mock.calls[0]?.[0] as Record<string, unknown>;

  // The regular free-text handling: a single write, conditional on a not-yet-final status.
  const expectFreeTextDowngrade = (update: ReturnType<typeof jest.spyOn>) => {
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      {
        _id: orderId,
        customerConfirmationStatus: {
          $nin: [CustomerConfirmationStatus.CONFIRMED, CustomerConfirmationStatus.CANCELLED, CustomerConfirmationStatus.EXPIRED]
        }
      },
      {
        $set: expect.objectContaining({
          attentionReasonCode: AttentionReasonCode.FREE_TEXT,
          customerConfirmationStatus: CustomerConfirmationStatus.NEEDS_ATTENTION
        })
      }
    );
  };

  it.each(['221776986780', '+221776986780', '776986780'])(
    'confirms with source whatsapp_button when the sender %p is the order phone',
    async from => {
      mockOrderLookups(order);
      const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({ _id: orderId } as never);
      const freeText = jest.spyOn(Order, 'findByIdAndUpdate');
      const createEvent = jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);
      jest.spyOn(Message, 'create').mockResolvedValue({ _id: new Types.ObjectId() } as never);
      const req = webhookRequest(textMessage(from, 'Je confirme ma commande #1234'));
      const { res, status } = mockResponse();

      await WhatsAppWebhookController.receive(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(update.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({
          $set: expect.objectContaining({
            customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED,
            confirmationSource: ConfirmationSource.WHATSAPP_BUTTON
          })
        })
      );
      expect(createEvent.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ type: OrderEventType.CONFIRMED, metadata: { source: ConfirmationSource.WHATSAPP_BUTTON } })
      );
      expect(freeText).not.toHaveBeenCalled();
      expect(inboundEvent()).toEqual(
        expect.objectContaining({ orderId, processedStatus: InboundWhatsAppEventStatus.PROCESSED })
      );
      expect(forward).toHaveBeenCalledWith(req.body);
    }
  );

  it('flags phone_mismatch without confirming when the sender is another number', async () => {
    mockOrderLookups(order);
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({ _id: orderId } as never);
    const freeText = jest.spyOn(Order, 'findByIdAndUpdate');
    const createEvent = jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);
    const createMessage = jest.spyOn(Message, 'create');
    const req = webhookRequest(textMessage(OTHER_SENDER, 'JE CONFIRME MA COMMANDE #1234'));
    const { res, status } = mockResponse();

    await WhatsAppWebhookController.receive(req, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[1]).toEqual({
      $set: expect.objectContaining({
        needsHelpdeskAttention: true,
        attentionReasonCode: AttentionReasonCode.PHONE_MISMATCH,
        attentionReason: expect.any(String)
      })
    });
    const set = (update.mock.calls[0]?.[1] as { $set: Record<string, unknown> }).$set;
    expect(set).not.toHaveProperty('customerConfirmationStatus');
    expect(set).not.toHaveProperty('confirmationSource');
    expect(createEvent.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ type: OrderEventType.PHONE_MISMATCH, metadata: expect.objectContaining({ senderE164: '+221771112233' }) })
    );
    expect(createMessage).not.toHaveBeenCalled();
    expect(freeText).not.toHaveBeenCalled();
    expect(inboundEvent()).toEqual(
      expect.objectContaining({ orderId, processedStatus: InboundWhatsAppEventStatus.NEEDS_ATTENTION })
    );
    expect(forward).toHaveBeenCalledWith(req.body);
  });

  it('records and mirrors the message even when the phone_mismatch event cannot be created', async () => {
    mockOrderLookups(order);
    jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({ _id: orderId } as never);
    const freeText = jest.spyOn(Order, 'findByIdAndUpdate');
    jest.spyOn(OrderEvent, 'create').mockRejectedValue(new Error('mongo down') as never);
    const req = webhookRequest(textMessage(OTHER_SENDER, 'Je confirme ma commande #1234'));
    const { res, status, json } = mockResponse();

    await WhatsAppWebhookController.receive(req, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(freeText).not.toHaveBeenCalled();
    expect(inboundEvent()).toEqual(
      expect.objectContaining({ orderId, processedStatus: InboundWhatsAppEventStatus.NEEDS_ATTENTION })
    );
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ inboundEvents: 1 }));
    expect(forward).toHaveBeenCalledWith(req.body);
  });

  it.each([
    ['a question about the order', 'Où en est ma commande #1234 ?'],
    ['an unknown reference', 'Je confirme ma commande #9999'],
    ['a confirmation without reference', 'Je confirme ma commande'],
    ['a negated confirmation', 'Je ne confirme pas ma commande #1234'],
    ['a cancellation', "je confirme l'annulation de #1234"]
  ])('keeps the regular free-text handling for %s', async (_label, body) => {
    mockOrderLookups(order);
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({ _id: orderId } as never);
    const freeText = jest.spyOn(Order, 'findByIdAndUpdate').mockResolvedValue({} as never);
    const createEvent = jest.spyOn(OrderEvent, 'create');
    const req = webhookRequest(textMessage('221776986780', body));
    const { res } = mockResponse();

    await WhatsAppWebhookController.receive(req, res);

    // Only the conditional free-text downgrade is written, never a confirmation.
    expectFreeTextDowngrade(update);
    expect(freeText).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
    expect(forward).toHaveBeenCalledWith(req.body);
  });

  it('does not transition an already confirmed order and keeps the regular handling', async () => {
    order.customerConfirmationStatus = CustomerConfirmationStatus.CONFIRMED;
    mockOrderLookups(order);
    const update = jest.spyOn(Order, 'findOneAndUpdate');
    const freeText = jest.spyOn(Order, 'findByIdAndUpdate').mockResolvedValue({} as never);
    const createEvent = jest.spyOn(OrderEvent, 'create');
    const req = webhookRequest(textMessage('221776986780', 'Je confirme ma commande #1234'));
    const { res } = mockResponse();

    await WhatsAppWebhookController.receive(req, res);

    expect(update).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
    // Regular handling: flagged as free text, confirmation status preserved.
    const set = (freeText.mock.calls[0]?.[1] as { $set: Record<string, unknown> }).$set;
    expect(set).toEqual(expect.objectContaining({ attentionReasonCode: AttentionReasonCode.FREE_TEXT }));
    expect(set).not.toHaveProperty('customerConfirmationStatus');
    expect(forward).toHaveBeenCalledWith(req.body);
  });

  it('keeps the order confirmed, records and mirrors the message when the confirmed template cannot be enqueued', async () => {
    mockOrderLookups(order);
    const update = jest
      .spyOn(Order, 'findOneAndUpdate')
      .mockResolvedValue({ _id: orderId, customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED } as never);
    const freeText = jest.spyOn(Order, 'findByIdAndUpdate');
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);
    jest.spyOn(Message, 'create').mockResolvedValue({ _id: new Types.ObjectId() } as never);
    const logError = jest.spyOn(log, 'error').mockImplementation((() => undefined) as never);
    jest.mocked(enqueueOrderConfirmed).mockRejectedValueOnce(new Error('redis down'));
    const req = webhookRequest(textMessage('221776986780', 'Je confirme ma commande #1234'));
    const { res, status, json } = mockResponse();

    await WhatsAppWebhookController.receive(req, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(freeText).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ orderId }), expect.any(String));
    expect(inboundEvent()).toEqual(
      expect.objectContaining({ orderId, processedStatus: InboundWhatsAppEventStatus.PROCESSED })
    );
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ inboundEvents: 1 }));
    expect(forward).toHaveBeenCalledWith(req.body);
  });

  it('falls back to the regular handling when the pre-filled lookup fails before any write', async () => {
    jest.spyOn(Order, 'findOne').mockImplementation(((filter: Record<string, unknown>) => {
      if ('shopifyOrderName' in filter) {
        return Promise.reject(new Error('mongo timeout'));
      }

      return { sort: () => Promise.resolve(order) };
    }) as never);
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({ _id: orderId } as never);
    const freeText = jest.spyOn(Order, 'findByIdAndUpdate').mockResolvedValue({} as never);
    jest.spyOn(log, 'error').mockImplementation((() => undefined) as never);
    const req = webhookRequest(textMessage('221776986780', 'Je confirme ma commande #1234'));
    const { res, status, json } = mockResponse();

    await WhatsAppWebhookController.receive(req, res);

    expect(status).toHaveBeenCalledWith(200);
    expectFreeTextDowngrade(update);
    expect(freeText).not.toHaveBeenCalled();
    expect(inboundEvent()).toEqual(
      expect.objectContaining({ orderId, processedStatus: InboundWhatsAppEventStatus.NEEDS_ATTENTION })
    );
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ inboundEvents: 1 }));
    expect(forward).toHaveBeenCalledWith(req.body);
  });

  it('skips a Meta redelivery of the same message', async () => {
    jest.spyOn(InboundWhatsAppEvent, 'exists').mockResolvedValue({ _id: new Types.ObjectId() } as never);
    const findOne = jest.spyOn(Order, 'findOne');
    const update = jest.spyOn(Order, 'findOneAndUpdate');
    const { res, json } = mockResponse();

    await WhatsAppWebhookController.receive(webhookRequest(textMessage(OTHER_SENDER, 'Je confirme ma commande #1234')), res);

    expect(findOne).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ inboundEvents: 0, duplicates: 1 }));
  });

  it('keeps the Confirm button free of any phone check', async () => {
    jest.spyOn(Order, 'findById').mockResolvedValue(order as never);
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({ _id: orderId } as never);
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);
    jest.spyOn(Message, 'create').mockResolvedValue({ _id: new Types.ObjectId() } as never);
    const req = webhookRequest({
      from: OTHER_SENDER,
      type: 'button',
      button: { payload: `CONFIRM_ORDER:${orderId.toString()}`, text: 'Confirmer' }
    });
    const { res } = mockResponse();

    await WhatsAppWebhookController.receive(req, res);

    expect(update.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        $set: expect.objectContaining({
          customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED,
          confirmationSource: ConfirmationSource.WHATSAPP_BUTTON,
          lastCustomerMessageText: 'Confirmer'
        })
      })
    );
    expect(inboundEvent()).toEqual(expect.objectContaining({ processedStatus: InboundWhatsAppEventStatus.PROCESSED }));
    expect(forward).toHaveBeenCalledWith(req.body);
  });
});

describe('WhatsApp webhook: an order cancelled or expired is confirmed by an agent only (C5.16)', () => {
  const orderId = new Types.ObjectId();
  const FROM = '221776986780';
  let state: Record<string, unknown>;
  let messageCount = 0;

  type Update = { $set?: Record<string, unknown>; $unset?: Record<string, unknown> };

  // MongoDB semantics for the operators the services write with: `null`, `$ne` and `$nin`
  // also match a missing field.
  const matches = (filter: Record<string, unknown>) =>
    Object.entries(filter).every(([key, condition]) => {
      const value = state[key];

      if (key === '_id') {
        return String(condition) === String(value);
      }

      if (condition === null) {
        return value === null || value === undefined;
      }

      if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
        const ops = condition as { $in?: unknown[]; $nin?: unknown[]; $ne?: unknown };

        if (ops.$in) {
          return ops.$in.includes(value);
        }

        if (ops.$nin) {
          return !ops.$nin.includes(value ?? null);
        }

        return value !== ops.$ne;
      }

      return value === condition;
    });

  const apply = (update: Update) => {
    Object.assign(state, update.$set ?? {});
    Object.keys(update.$unset ?? {}).forEach(key => delete state[key]);
  };

  beforeEach(() => {
    state = {
      _id: orderId,
      shopifyOrderName: '#1234',
      customerPhoneE164: ORDER_PHONE,
      customerConfirmationStatus: CustomerConfirmationStatus.PENDING,
      reminderCount: 0
    };
    jest.spyOn(InboundWhatsAppEvent, 'exists').mockResolvedValue(null as never);
    jest.spyOn(InboundWhatsAppEvent, 'create').mockResolvedValue({} as never);
    jest.spyOn(ChatwootForwardService, 'forwardWhatsAppPayload').mockResolvedValue(true as never);
    jest.spyOn(Order, 'findOne').mockImplementation(((filter: Record<string, unknown>) => {
      if ('shopifyOrderName' in filter) {
        return Promise.resolve(filter.shopifyOrderName === state.shopifyOrderName ? { ...state } : null);
      }

      const result = filter.customerPhoneE164 === state.customerPhoneE164 ? { ...state } : null;
      return { sort: () => Promise.resolve(result) };
    }) as never);
    jest.spyOn(Order, 'findById').mockImplementation((() => {
      const doc: Record<string, unknown> = { ...state };
      doc.save = async () => {
        const { save: _save, ...fields } = doc;
        Object.keys(state).forEach(key => delete state[key]);
        Object.assign(state, Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)));
      };
      return Promise.resolve(doc);
    }) as never);
    jest.spyOn(Order, 'findOneAndUpdate').mockImplementation(((filter: Record<string, unknown>, update: Update) =>
      Promise.resolve().then(() => {
        if (!matches(filter)) {
          return null;
        }
        apply(update);
        return { ...state };
      })) as never);
    jest.spyOn(Order, 'findByIdAndUpdate').mockImplementation(((_id: unknown, update: Update) =>
      Promise.resolve().then(() => {
        apply(update);
        return { ...state };
      })) as never);
    jest.spyOn(Order, 'exists').mockResolvedValue({ _id: orderId } as never);
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);
    jest.spyOn(Message, 'create').mockResolvedValue({ _id: new Types.ObjectId() } as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const receive = async (message: Record<string, unknown>) => {
    messageCount += 1;
    const { res } = mockResponse();
    await WhatsAppWebhookController.receive(webhookRequest({ id: `wamid.c516.${messageCount}`, ...message }), res);
  };

  const press = () =>
    receive({ from: FROM, type: 'button', button: { payload: `CONFIRM_ORDER:${orderId.toString()}`, text: 'Confirmer' } });
  const freeText = () => receive(textMessage(FROM, 'Bonjour, je veux toujours ma commande'));
  const prefilled = () => receive(textMessage(FROM, 'Je confirme ma commande #1234'));
  const reaction = () => receive({ from: FROM, type: 'reaction', reaction: { emoji: '👍', message_id: 'wamid.out.1' } });
  const unreachable = () => OrderConfirmationService.markUnreachable(orderId.toString());
  // The notification worker SMS fallback (conditional write on a still-confirmable order).
  const smsFallback = async () => {
    await Order.findOneAndUpdate(
      { _id: orderId, customerConfirmationStatus: { $in: [CustomerConfirmationStatus.PENDING, CustomerConfirmationStatus.NEEDS_ATTENTION] } },
      {
        $set: {
          customerConfirmationStatus: CustomerConfirmationStatus.SMS_ONLY,
          attentionReasonCode: AttentionReasonCode.SMS_ONLY,
          needsHelpdeskAttention: true
        }
      }
    );
  };

  const closeOrder = {
    'cancelled by an agent': async () => {
      await OrderConfirmationService.cancelByAdmin(orderId.toString(), 'Client injoignable depuis 3 jours');
    },
    expired: async () => {
      // Same write as the confirmation maintenance sweep.
      apply({ $set: { customerConfirmationStatus: CustomerConfirmationStatus.EXPIRED, expiredAt: new Date() } });
    }
  };

  const expectNeverConfirmed = () => {
    expect(state.customerConfirmationStatus).not.toBe(CustomerConfirmationStatus.CONFIRMED);
    expect(state.operationalStatus).toBeUndefined();
    expect(state.confirmedAt).toBeUndefined();
    expect(triggerCapiPurchase).not.toHaveBeenCalled();
    expect(enqueueOrderConfirmed).not.toHaveBeenCalled();
  };

  const interludes: Array<[string, () => Promise<unknown>]> = [
    ['a free text', freeText],
    ['a pre-filled message', prefilled],
    ['a reaction', reaction],
    ['an agent marking it unreachable', unreachable],
    ['the SMS fallback', smsFallback]
  ];

  describe.each(Object.entries(closeOrder))('order %s', (_label, close) => {
    it.each(interludes)('press, then %s, then press again: never confirmed', async (_interlude, interlude) => {
      await close();
      await press();
      expect(state.attentionReasonCode).toBe(AttentionReasonCode.LATE_CONFIRM);

      await interlude();
      expect(state.attentionReasonCode).not.toBe(AttentionReasonCode.LATE_CONFIRM);
      await press();

      expectNeverConfirmed();
      expect(state.customerConfirmationStatus).toBe(CustomerConfirmationStatus.NEEDS_ATTENTION);
      expect(state.attentionReasonCode).toBe(AttentionReasonCode.LATE_CONFIRM);
    });

    it('press, then two pre-filled messages: never confirmed', async () => {
      await close();
      await press();
      await prefilled();
      await prefilled();

      expectNeverConfirmed();
    });

    it('a burst of presses, pre-filled messages and texts: never confirmed', async () => {
      await close();
      await press();
      await Promise.all([press(), prefilled(), freeText(), press(), reaction(), prefilled(), press()]);
      await press();
      await prefilled();
      await press();

      expectNeverConfirmed();
    });

    it('an agent still confirms it, with a single Purchase and a single confirmed message', async () => {
      await close();
      await press();
      await freeText();
      await press();

      await OrderConfirmationService.confirmByAdmin(orderId.toString());
      await press();
      await prefilled();

      expect(state.customerConfirmationStatus).toBe(CustomerConfirmationStatus.CONFIRMED);
      expect(state.confirmationSource).toBe(ConfirmationSource.ADMIN);
      expect(triggerCapiPurchase).toHaveBeenCalledTimes(1);
      expect(enqueueOrderConfirmed).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    ['the button', press],
    ['the pre-filled message', prefilled]
  ])('still confirms by %s an order needing attention that was never cancelled nor expired', async (_label, confirm) => {
    await freeText();
    expect(state).toEqual(
      expect.objectContaining({
        customerConfirmationStatus: CustomerConfirmationStatus.NEEDS_ATTENTION,
        attentionReasonCode: AttentionReasonCode.FREE_TEXT
      })
    );

    await confirm();

    expect(state.customerConfirmationStatus).toBe(CustomerConfirmationStatus.CONFIRMED);
    expect(state.confirmationSource).toBe(ConfirmationSource.WHATSAPP_BUTTON);
    expect(triggerCapiPurchase).toHaveBeenCalledTimes(1);
    expect(enqueueOrderConfirmed).toHaveBeenCalledTimes(1);
  });

  // C5.24: a free text read while the order was still pending must not demote a confirmation
  // written in between (by the button or an agent): the sale keeps its Purchase.
  it.each([
    ['the button', ConfirmationSource.WHATSAPP_BUTTON],
    ['an agent phone call', ConfirmationSource.PHONE_CALL]
  ])('keeps an order confirmed by %s between the free-text read and its write', async (_label, source) => {
    const stale = { ...state };
    Object.assign(state, {
      customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED,
      confirmationSource: source,
      confirmedAt: new Date()
    });
    jest.mocked(Order.findOne).mockImplementation(((filter: Record<string, unknown>) => {
      if ('shopifyOrderName' in filter) {
        return Promise.resolve(null);
      }

      return { sort: () => Promise.resolve({ ...stale }) };
    }) as never);

    await freeText();

    expect(state).toEqual(
      expect.objectContaining({
        customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED,
        confirmationSource: source,
        attentionReasonCode: AttentionReasonCode.FREE_TEXT,
        needsHelpdeskAttention: true,
        lastCustomerMessageText: 'Bonjour, je veux toujours ma commande'
      })
    );
    expect(InboundWhatsAppEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ orderId, processedStatus: InboundWhatsAppEventStatus.NEEDS_ATTENTION })
    );
  });

  it('still moves a pending order to needs_attention on a free text (no race)', async () => {
    await freeText();

    expect(state).toEqual(
      expect.objectContaining({
        customerConfirmationStatus: CustomerConfirmationStatus.NEEDS_ATTENTION,
        attentionReasonCode: AttentionReasonCode.FREE_TEXT,
        needsHelpdeskAttention: true
      })
    );
  });
});
