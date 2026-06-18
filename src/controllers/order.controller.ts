import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { Message } from '../models/Message';
import { CustomerConfirmationStatus, NotificationStatus, Order } from '../models/Order';
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

const escapeRegExp = (value: string) => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const createPagination = (page: number, limit: number, total: number) => {
  return {
    page,
    limit,
    total,
    pages: Math.ceil(total / limit)
  };
};

const buildMessageSummary = (messages: Array<{ channel: string; provider: string; status: string }>) => {
  return messages.reduce(
    (summary, message) => {
      summary.total += 1;
      summary.byStatus[message.status] = (summary.byStatus[message.status] || 0) + 1;
      summary.byChannel[message.channel] = (summary.byChannel[message.channel] || 0) + 1;
      summary.byProvider[message.provider] = (summary.byProvider[message.provider] || 0) + 1;

      return summary;
    },
    {
      total: 0,
      byStatus: {} as Record<string, number>,
      byChannel: {} as Record<string, number>,
      byProvider: {} as Record<string, number>
    }
  );
};

export class OrderController {
  public static async list(req: Request, res: Response) {
    const page = toPositiveInteger(req.query.page, 1);
    const limit = Math.min(toPositiveInteger(req.query.limit, DEFAULT_LIMIT), MAX_LIMIT);
    const skip = (page - 1) * limit;
    const status = toStringFilter(req.query.status);
    const customerConfirmationStatus = toStringFilter(req.query.customerConfirmationStatus);
    const orderName = toStringFilter(req.query.orderName);
    const phone = toStringFilter(req.query.phone);

    const filters: Record<string, unknown> = {};

    if (status && Object.values(NotificationStatus).includes(status as NotificationStatus)) {
      filters.notificationStatus = status;
    }

    if (
      customerConfirmationStatus &&
      Object.values(CustomerConfirmationStatus).includes(customerConfirmationStatus as CustomerConfirmationStatus)
    ) {
      filters.customerConfirmationStatus = customerConfirmationStatus;
    }

    if (orderName) {
      filters.shopifyOrderName = { $regex: escapeRegExp(orderName), $options: 'i' };
    }

    if (phone) {
      filters.$or = [
        { customerPhoneE164: { $regex: escapeRegExp(phone), $options: 'i' } },
        { customerPhoneRaw: { $regex: escapeRegExp(phone), $options: 'i' } }
      ];
    }

    const [orders, total] = await Promise.all([
      Order.find(filters).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Order.countDocuments(filters)
    ]);

    log.info(
      {
        page,
        limit,
        total,
        returned: orders.length,
        status,
        customerConfirmationStatus,
        hasOrderNameFilter: Boolean(orderName),
        hasPhoneFilter: Boolean(phone)
      },
      'Listed orders'
    );

    return res.status(200).json({
      data: orders,
      pagination: createPagination(page, limit, total)
    });
  }

  public static async detail(req: Request, res: Response) {
    const id = typeof req.params.id === 'string' ? req.params.id : '';

    if (!Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'OrderNotFound' });
    }

    const order = await Order.findById(id);

    if (!order) {
      return res.status(404).json({ error: 'OrderNotFound' });
    }

    const messages = await Message.find({ orderId: order._id }).sort({ createdAt: -1 });
    const messageSummary = buildMessageSummary(messages);

    log.info(
      {
        orderId: order._id,
        shopifyOrderId: order.shopifyOrderId,
        messageCount: messages.length
      },
      'Fetched order detail'
    );

    return res.status(200).json({
      data: {
        order,
        messages,
        messageSummary
      }
    });
  }
}
