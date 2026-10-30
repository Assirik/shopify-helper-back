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
import { ChatwootForwardService } from '../utilities/services/chatwootForward.service';
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
    const req = webhookRequest(textMessage(OTHER_SENDER, 'CONFIRMÉ commande #1234'));
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
    const update = jest.spyOn(Order, 'findOneAndUpdate');
    const freeText = jest.spyOn(Order, 'findByIdAndUpdate').mockResolvedValue({} as never);
    const createEvent = jest.spyOn(OrderEvent, 'create');
    const req = webhookRequest(textMessage('221776986780', body));
    const { res } = mockResponse();

    await WhatsAppWebhookController.receive(req, res);

    expect(update).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
    expect(freeText).toHaveBeenCalledWith(orderId, {
      $set: expect.objectContaining({
        attentionReasonCode: AttentionReasonCode.FREE_TEXT,
        customerConfirmationStatus: CustomerConfirmationStatus.NEEDS_ATTENTION
      })
    });
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
    const update = jest.spyOn(Order, 'findOneAndUpdate');
    const freeText = jest.spyOn(Order, 'findByIdAndUpdate').mockResolvedValue({} as never);
    jest.spyOn(log, 'error').mockImplementation((() => undefined) as never);
    const req = webhookRequest(textMessage('221776986780', 'Je confirme ma commande #1234'));
    const { res, status, json } = mockResponse();

    await WhatsAppWebhookController.receive(req, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(update).not.toHaveBeenCalled();
    expect(freeText).toHaveBeenCalledWith(orderId, {
      $set: expect.objectContaining({ attentionReasonCode: AttentionReasonCode.FREE_TEXT })
    });
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
