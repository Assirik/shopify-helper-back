import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { Message } from '../models/Message';
import { AttentionReasonCode, CustomerConfirmationStatus, IOrder, NotificationStatus, Order } from '../models/Order';
import { getOrderActionCapabilities } from '../utilities/services/orderCapabilities.service';
import { OrderConfirmationError, OrderConfirmationService } from '../utilities/services/orderConfirmation.service';
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

const MAX_BULK_ORDERS = 100;
const BULK_CONCURRENCY = 5;

export const buildOrderListFilters = (query: Pick<Request, 'query'>['query']) => {
  const status = toStringFilter(query.status);
  const customerConfirmationStatus = toStringFilter(query.customerConfirmationStatus);
  const orderName = toStringFilter(query.orderName);
  const phone = toStringFilter(query.phone);
  const cod = toStringFilter(query.cod);

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

  if (cod === 'true' || cod === 'false') {
    filters.isCashOnDelivery = cod === 'true';
  }

  return {
    filters,
    status,
    customerConfirmationStatus,
    orderName,
    phone,
    cod
  };
};

export const parseBulkOrderIds = (value: unknown) => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BULK_ORDERS) {
    return undefined;
  }

  const ids = [...new Set(value)];
  if (ids.length !== value.length || !ids.every(id => typeof id === 'string' && Types.ObjectId.isValid(id))) {
    return undefined;
  }

  return ids as string[];
};

const runWithConcurrency = async <T>(items: string[], task: (item: string) => Promise<T>) => {
  const results: Array<PromiseSettledResult<T> & { orderId: string }> = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const orderId = items[index];

      try {
        results[index] = { status: 'fulfilled', value: await task(orderId), orderId };
      } catch (reason) {
        results[index] = { status: 'rejected', reason, orderId };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, items.length) }, worker));
  return results;
};

const toBulkFailure = (orderId: string, reason: unknown) => {
  if (reason instanceof OrderConfirmationError) {
    return { orderId, error: reason.code, status: reason.status };
  }

  return { orderId, error: 'InternalError', status: 500 };
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

export const toAttentionOrder = (order: IOrder) => ({
  id: order._id.toString(),
  orderName: order.shopifyOrderName,
  customerName: order.customerName || 'Client non renseigné',
  customerPhone: order.customerPhoneE164 || order.customerPhoneRaw || '',
  region: order.deliveryRegion || order.shippingRegion || 'Non renseignée',
  amount: {
    value: order.totalPrice,
    currency: order.currency
  },
  isCashOnDelivery: order.isCashOnDelivery,
  reason: order.attentionReasonCode,
  lastCustomerMessage: order.lastCustomerMessageText || '',
  receivedAt: order.attentionRequiredAt || order.lastCustomerMessageAt || order.updatedAt || order.createdAt,
  customerConfirmationStatus: order.customerConfirmationStatus,
  capabilities: getOrderActionCapabilities(order)
});

export class OrderController {
  public static async bulkConfirm(req: Request, res: Response) {
    const orderIds = parseBulkOrderIds(req.body?.orderIds);
    if (!orderIds) return res.status(400).json({ error: 'InvalidOrderIds' });

    const results = await runWithConcurrency(orderIds, orderId => OrderConfirmationService.confirmByAdmin(orderId));
    const succeeded = results
      .filter(result => result.status === 'fulfilled')
      .map(result => ({ orderId: result.orderId }));
    const failed = results
      .filter((result): result is PromiseRejectedResult & { orderId: string } => result.status === 'rejected')
      .map(result => toBulkFailure(result.orderId, result.reason));

    log.info(
      { adminId: req.userId, requested: orderIds.length, succeeded: succeeded.length, failed: failed.length },
      'Bulk order confirmation completed'
    );

    return res.status(failed.length ? 207 : 200).json({
      data: {
        requested: orderIds.length,
        succeeded,
        failed,
        summary: { succeeded: succeeded.length, failed: failed.length }
      }
    });
  }

  public static async bulkRemind(req: Request, res: Response) {
    const orderIds = parseBulkOrderIds(req.body?.orderIds);
    if (!orderIds) return res.status(400).json({ error: 'InvalidOrderIds' });

    const results = await runWithConcurrency(orderIds, orderId => OrderConfirmationService.remindByAdmin(orderId));
    const succeeded = results
      .filter(result => result.status === 'fulfilled')
      .map(result => ({ orderId: result.orderId }));
    const failed = results
      .filter((result): result is PromiseRejectedResult & { orderId: string } => result.status === 'rejected')
      .map(result => toBulkFailure(result.orderId, result.reason));

    log.info(
      { adminId: req.userId, requested: orderIds.length, succeeded: succeeded.length, failed: failed.length },
      'Bulk order reminder completed'
    );

    return res.status(failed.length ? 207 : 200).json({
      data: {
        requested: orderIds.length,
        succeeded,
        failed,
        summary: { succeeded: succeeded.length, failed: failed.length }
      }
    });
  }

  public static async attentionQueue(req: Request, res: Response) {
    const page = toPositiveInteger(req.query.page, 1);
    const limit = Math.min(toPositiveInteger(req.query.limit, DEFAULT_LIMIT), MAX_LIMIT);
    const reason = toStringFilter(req.query.reason);

    if (reason && !Object.values(AttentionReasonCode).includes(reason as AttentionReasonCode)) {
      return res.status(400).json({ error: 'InvalidAttentionReason' });
    }

    const filters: Record<string, unknown> = {
      needsHelpdeskAttention: true,
      attentionReasonCode: reason ? reason : { $in: Object.values(AttentionReasonCode) }
    };

    const [orders, total, groupedCounts] = await Promise.all([
      Order.find(filters)
        .sort({ attentionRequiredAt: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Order.countDocuments(filters),
      Order.aggregate<{ _id: AttentionReasonCode; count: number }>([
        {
          $match: {
            needsHelpdeskAttention: true,
            attentionReasonCode: { $in: Object.values(AttentionReasonCode) }
          }
        },
        { $group: { _id: '$attentionReasonCode', count: { $sum: 1 } } }
      ])
    ]);

    const counts = Object.values(AttentionReasonCode).reduce(
      (result, code) => {
        result[code] = groupedCounts.find(item => item._id === code)?.count || 0;
        return result;
      },
      {
        all: groupedCounts.reduce((sum, item) => sum + item.count, 0),
        free_text: 0,
        sms_only: 0,
        invalid_number: 0,
        late_confirm: 0
      } as Record<'all' | AttentionReasonCode, number>
    );

    log.info({ page, limit, reason: reason || 'all', total, returned: orders.length }, 'Listed attention queue');

    return res.status(200).json({
      data: orders.map(toAttentionOrder),
      counts,
      pagination: createPagination(page, limit, total)
    });
  }

  public static async list(req: Request, res: Response) {
    const page = toPositiveInteger(req.query.page, 1);
    const limit = Math.min(toPositiveInteger(req.query.limit, DEFAULT_LIMIT), MAX_LIMIT);
    const skip = (page - 1) * limit;
    const { filters, status, customerConfirmationStatus, orderName, phone, cod } = buildOrderListFilters(req.query);

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
        hasPhoneFilter: Boolean(phone),
        hasCodFilter: cod === 'true' || cod === 'false'
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

  public static async confirm(req: Request, res: Response) {
    const id = typeof req.params.id === 'string' ? req.params.id : '';

    try {
      const result = await OrderConfirmationService.confirmByAdmin(id);

      log.info(
        {
          orderId: result.order._id,
          messageId: result.message._id,
          jobId: result.job.id
        },
        'Admin confirmed order'
      );

      return res.status(202).json({
        data: {
          order: result.order,
          message: result.message,
          jobId: result.job.id,
          queueName: result.job.queueName
        }
      });
    } catch (err) {
      if (err instanceof OrderConfirmationError) {
        return res.status(err.status).json({ error: err.code });
      }

      throw err;
    }
  }

  public static async cancel(req: Request, res: Response) {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : undefined;

    try {
      const result = await OrderConfirmationService.cancelByAdmin(id, reason);

      log.info(
        {
          orderId: result.order._id,
          reason,
          notifiedCustomer: Boolean(result.notification)
        },
        'Admin cancelled order confirmation'
      );

      return res.status(200).json({
        data: {
          order: result.order,
          message: result.notification?.message,
          jobId: result.notification?.job.id,
          queueName: result.notification?.job.queueName
        }
      });
    } catch (err) {
      if (err instanceof OrderConfirmationError) {
        return res.status(err.status).json({ error: err.code });
      }

      throw err;
    }
  }

  public static async remind(req: Request, res: Response) {
    const id = typeof req.params.id === 'string' ? req.params.id : '';

    try {
      const result = await OrderConfirmationService.remindByAdmin(id);

      log.info(
        {
          orderId: result.order._id,
          messageId: result.message._id,
          jobId: result.job.id,
          reminderCount: result.order.reminderCount
        },
        'Admin reminded order confirmation'
      );

      return res.status(202).json({
        data: {
          order: result.order,
          message: result.message,
          jobId: result.job.id,
          queueName: result.job.queueName
        }
      });
    } catch (err) {
      if (err instanceof OrderConfirmationError) {
        return res.status(err.status).json({ error: err.code });
      }

      throw err;
    }
  }
}
