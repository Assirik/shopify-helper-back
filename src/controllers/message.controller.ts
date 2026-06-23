import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { IMessage, Message, MessageChannel, MessageProvider, MessageStatus } from '../models/Message';
import { IOrder, Order } from '../models/Order';
import { enqueueOrderConfirmation } from '../queues/notification.queue';
import log from '../utilities/logger/logger';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const toPositiveInteger = (value: unknown, fallback: number) => {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
};

const toStringFilter = (value: unknown) => {
  return typeof value === 'string' ? value.trim() : '';
};

const createPagination = (page: number, limit: number, total: number) => {
  return {
    page,
    limit,
    total,
    pages: Math.ceil(total / limit)
  };
};

type JsonRecord = Record<string, unknown>;
type MessageJson = JsonRecord & {
  _id?: unknown;
  id?: unknown;
  orderId?: unknown;
  channel?: unknown;
  fallbackOfMessageId?: unknown;
};
type EnrichedMessageJson = MessageJson & {
  orderName?: string;
  fallbackOf?: {
    id: string;
    orderName?: string;
    channel?: string;
  };
};

const toIdString = (value: unknown) => {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Types.ObjectId) {
    return value.toString();
  }

  if (value && typeof value === 'object' && 'toString' in value) {
    return String(value);
  }

  return '';
};

const uniqueIds = (values: unknown[]) => {
  return [...new Set(values.map(toIdString).filter(Boolean))];
};

const toMessageJson = (message: IMessage) => message.toJSON() as MessageJson;

const buildOrderNameMap = async (orderIds: string[]) => {
  if (orderIds.length === 0) {
    return new Map<string, string>();
  }

  const orders = await Order.find({ _id: { $in: orderIds } });

  return orders.reduce((map, order: IOrder) => {
    map.set(order._id.toString(), order.shopifyOrderName);
    return map;
  }, new Map<string, string>());
};

export const enrichMessages = async (messages: IMessage[]): Promise<EnrichedMessageJson[]> => {
  const messageJsons = messages.map(toMessageJson);
  const orderNameById = await buildOrderNameMap(uniqueIds(messageJsons.map(message => message.orderId)));

  const fallbackIds = uniqueIds(messageJsons.map(message => message.fallbackOfMessageId));
  const fallbackMessages = fallbackIds.length > 0 ? await Message.find({ _id: { $in: fallbackIds } }) : [];
  const fallbackJsons = fallbackMessages.map(toMessageJson);
  const fallbackOrderNameById = await buildOrderNameMap(uniqueIds(fallbackJsons.map(message => message.orderId)));

  const fallbackById = fallbackJsons.reduce((map, message) => {
    const messageId = toIdString(message._id || message.id);
    if (!messageId) return map;

    map.set(messageId, {
      id: messageId,
      orderName: fallbackOrderNameById.get(toIdString(message.orderId)),
      channel: typeof message.channel === 'string' ? message.channel : undefined
    });
    return map;
  }, new Map<string, { id: string; orderName?: string; channel?: string }>());

  return messageJsons.map(message => {
    const enriched = {
      ...message,
      orderName: orderNameById.get(toIdString(message.orderId))
    };
    const fallbackOf = fallbackById.get(toIdString(message.fallbackOfMessageId));

    if (!fallbackOf) {
      return enriched;
    }

    return {
      ...enriched,
      fallbackOf
    };
  });
};

export class MessageController {
  public static async list(req: Request, res: Response) {
    const page = toPositiveInteger(req.query.page, 1);
    const limit = Math.min(toPositiveInteger(req.query.limit, DEFAULT_LIMIT), MAX_LIMIT);
    const skip = (page - 1) * limit;
    const status = toStringFilter(req.query.status);
    const channel = toStringFilter(req.query.channel);
    const provider = toStringFilter(req.query.provider);

    const filters: Record<string, unknown> = {};

    if (status && Object.values(MessageStatus).includes(status as MessageStatus)) {
      filters.status = status;
    }

    if (channel && Object.values(MessageChannel).includes(channel as MessageChannel)) {
      filters.channel = channel;
    }

    if (provider && Object.values(MessageProvider).includes(provider as MessageProvider)) {
      filters.provider = provider;
    }

    const [messages, total] = await Promise.all([
      Message.find(filters).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Message.countDocuments(filters)
    ]);
    const enrichedMessages = await enrichMessages(messages);

    log.info(
      {
        page,
        limit,
        total,
        returned: enrichedMessages.length,
        status,
        channel,
        provider
      },
      'Listed messages'
    );

    return res.status(200).json({
      data: enrichedMessages,
      pagination: createPagination(page, limit, total)
    });
  }

  public static async detail(req: Request, res: Response) {
    const id = typeof req.params.id === 'string' ? req.params.id : '';

    if (!Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'MessageNotFound' });
    }

    const message = await Message.findById(id);

    if (!message) {
      return res.status(404).json({ error: 'MessageNotFound' });
    }

    log.info(
      {
        messageId: message._id,
        orderId: message.orderId,
        status: message.status,
        channel: message.channel,
        provider: message.provider
      },
      'Fetched message detail'
    );

    return res.status(200).json({
      data: message
    });
  }

  public static async retry(req: Request, res: Response) {
    const id = typeof req.params.id === 'string' ? req.params.id : '';

    if (!Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'MessageNotFound' });
    }

    const message = await Message.findById(id);

    if (!message) {
      return res.status(404).json({ error: 'MessageNotFound' });
    }

    if (message.status !== MessageStatus.FAILED) {
      return res.status(409).json({
        error: 'MessageRetryNotAllowed',
        status: message.status
      });
    }

    const requeued = await Message.findByIdAndUpdate(
      message._id,
      {
        $set: { status: MessageStatus.QUEUED },
        $unset: { errorCode: '', errorMessage: '' }
      },
      { new: true }
    );

    const job = await enqueueOrderConfirmation({
      orderId: message.orderId.toString(),
      messageId: message._id.toString(),
      channel: message.channel
    });

    log.info(
      {
        messageId: message._id,
        orderId: message.orderId,
        channel: message.channel,
        provider: message.provider,
        jobId: job.id
      },
      'Retried failed message'
    );

    return res.status(202).json({
      data: {
        message: requeued,
        jobId: job.id,
        queueName: job.queueName
      }
    });
  }
}
