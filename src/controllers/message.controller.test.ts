import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import { Message, MessageChannel, MessageProvider, MessageStatus } from '../models/Message';
import { Order } from '../models/Order';
import { enrichMessages } from './message.controller';

jest.mock('../queues/notification.queue', () => ({
  enqueueOrderConfirmation: jest.fn()
}));

afterEach(() => {
  jest.restoreAllMocks();
});

const messageDoc = (data: Record<string, unknown>) => ({
  toJSON: () => data
});

const orderDoc = (_id: Types.ObjectId, shopifyOrderName: string) => ({
  _id,
  shopifyOrderName
});

describe('message enrichment helpers', () => {
  it('adds orderName when the linked order exists', async () => {
    const orderId = new Types.ObjectId();
    jest.spyOn(Order, 'find').mockResolvedValueOnce([orderDoc(orderId, '#1042')] as never);
    jest.spyOn(Message, 'find').mockResolvedValueOnce([] as never);

    const [message] = await enrichMessages([
      messageDoc({
        _id: new Types.ObjectId(),
        orderId,
        channel: MessageChannel.WHATSAPP,
        provider: MessageProvider.META,
        status: MessageStatus.SENT
      }) as never
    ]);

    expect(message.orderName).toBe('#1042');
  });

  it('keeps orderName absent when the linked order does not exist', async () => {
    jest.spyOn(Order, 'find').mockResolvedValueOnce([] as never);
    jest.spyOn(Message, 'find').mockResolvedValueOnce([] as never);

    const [message] = await enrichMessages([
      messageDoc({
        _id: new Types.ObjectId(),
        orderId: new Types.ObjectId(),
        channel: MessageChannel.WHATSAPP,
        provider: MessageProvider.META,
        status: MessageStatus.SENT
      }) as never
    ]);

    expect(message.orderName).toBeUndefined();
  });

  it('adds fallbackOf with the original message orderName and channel', async () => {
    const orderId = new Types.ObjectId();
    const fallbackOrderId = new Types.ObjectId();
    const fallbackMessageId = new Types.ObjectId();

    jest.spyOn(Order, 'find')
      .mockResolvedValueOnce([orderDoc(orderId, '#1043')] as never)
      .mockResolvedValueOnce([orderDoc(fallbackOrderId, '#1042')] as never);
    jest.spyOn(Message, 'find').mockResolvedValueOnce([
      messageDoc({
        _id: fallbackMessageId,
        orderId: fallbackOrderId,
        channel: MessageChannel.WHATSAPP,
        provider: MessageProvider.META,
        status: MessageStatus.FAILED
      })
    ] as never);

    const [message] = await enrichMessages([
      messageDoc({
        _id: new Types.ObjectId(),
        orderId,
        channel: MessageChannel.SMS,
        provider: MessageProvider.TERMII,
        status: MessageStatus.SENT,
        fallbackOfMessageId: fallbackMessageId
      }) as never
    ]);

    expect(message.orderName).toBe('#1043');
    expect(message.fallbackOf).toEqual({
      id: fallbackMessageId.toString(),
      orderName: '#1042',
      channel: MessageChannel.WHATSAPP
    });
  });
});
