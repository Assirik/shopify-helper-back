import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import { Message, MessageChannel, MessageProvider, MessageStatus } from '../models/Message';
import { Order } from '../models/Order';
import { buildMessageListFilters, enrichMessages, MessageController } from './message.controller';

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

describe('message list filters', () => {
  it('filters messages by matching orderName', async () => {
    const orderId = new Types.ObjectId();
    jest.spyOn(Order, 'find').mockResolvedValueOnce([orderDoc(orderId, '#1042')] as never);

    const result = await buildMessageListFilters({ orderName: '1042' });

    expect(Order.find).toHaveBeenCalledWith({
      shopifyOrderName: { $regex: '1042', $options: 'i' }
    });
    expect(result.noMatches).toBe(false);
    expect(result.filters).toEqual({
      orderId: { $in: [orderId] }
    });
  });

  it('combines orderName with status filters', async () => {
    const orderId = new Types.ObjectId();
    jest.spyOn(Order, 'find').mockResolvedValueOnce([orderDoc(orderId, '#1042')] as never);

    const result = await buildMessageListFilters({
      orderName: '#1042',
      status: MessageStatus.FAILED
    });

    expect(result.filters).toEqual({
      orderId: { $in: [orderId] },
      status: MessageStatus.FAILED
    });
  });

  it('returns noMatches when no orderName matches', async () => {
    jest.spyOn(Order, 'find').mockResolvedValueOnce([] as never);

    const result = await buildMessageListFilters({ orderName: 'xxx' });

    expect(result.noMatches).toBe(true);
    expect(result.filters).toEqual({});
  });

  it('returns an empty page without searching messages when orderName has no matches', async () => {
    jest.spyOn(Order, 'find').mockResolvedValueOnce([] as never);
    const messageFind = jest.spyOn(Message, 'find');
    const countDocuments = jest.spyOn(Message, 'countDocuments');
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();

    await MessageController.list(
      { query: { orderName: 'xxx' } } as never,
      { status, json } as never
    );

    expect(messageFind).not.toHaveBeenCalled();
    expect(countDocuments).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({
      data: [],
      pagination: { page: 1, limit: 20, total: 0, pages: 0 }
    });
  });
});
