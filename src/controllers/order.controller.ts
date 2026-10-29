import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { Message } from '../models/Message';
import { IOrderEvent, OrderEvent } from '../models/OrderEvent';
import {
  AttentionReasonCode,
  CodPaymentStatus,
  ConfirmationSource,
  CustomerConfirmationStatus,
  DeliveryChannel,
  IOrder,
  NotificationStatus,
  Order,
  OrderOperationalStatus
} from '../models/Order';
import { getOrderActionCapabilities } from '../utilities/services/orderCapabilities.service';
import {
  ADMIN_CONFIRMATION_SOURCES,
  AdminConfirmationSource,
  OrderConfirmationError,
  OrderConfirmationService
} from '../utilities/services/orderConfirmation.service';
import { OrderFulfillmentError, OrderFulfillmentService } from '../utilities/services/orderFulfillment.service';
import { ReconciliationError, ReconciliationService } from '../utilities/services/reconciliation.service';
import { resolveRegion } from '../utilities/reference/senegalRegions';
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

// Montant optionnel : `undefined` (champ omis) => repli côté service ; toute autre valeur
// invalide (chaîne vide, null, non numérique, négative) => rejet, jamais de coercition en 0.
export const parseOptionalAmount = (value: unknown): { ok: true; value?: number } | { ok: false } => {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  if (typeof value !== 'number' && typeof value !== 'string') {
    return { ok: false };
  }

  if (typeof value === 'string' && value.trim() === '') {
    return { ok: false };
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { ok: false };
  }

  return { ok: true, value: parsed };
};

// Source de confirmation déclarée par l'agent : omise => `admin` (comportement historique),
// toute autre valeur que admin/phone_call => rejet.
export const parseConfirmationSource = (
  value: unknown
): { ok: true; value: AdminConfirmationSource } | { ok: false } => {
  if (value === undefined) return { ok: true, value: ConfirmationSource.ADMIN };
  const source = ADMIN_CONFIRMATION_SOURCES.find(candidate => candidate === value);
  return source ? { ok: true, value: source } : { ok: false };
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

// Champs couverts par la recherche unifiée (F20).
const SEARCH_FIELDS = [
  'shopifyOrderName',
  'customerName',
  'customerPhoneE164',
  'customerPhoneRaw',
  'customerEmail',
  'tags',
  'lineItems.title',
  'lineItems.sku'
];
const PHONE_FIELDS = ['customerPhoneE164', 'customerPhoneRaw'];
const PHONE_LIKE = /^[\d\s+().-]+$/;

const containsInsensitive = (value: string) => ({ $regex: escapeRegExp(value), $options: 'i' });

const buildSearchClause = (search: string) => {
  const clauses: Record<string, unknown>[] = SEARCH_FIELDS.map(field => ({ [field]: containsInsensitive(search) }));

  // « 77 412 88 90 » doit retrouver « +221774128890 » : on cherche aussi les chiffres seuls
  // sur les téléphones, uniquement si la saisie ressemble à un numéro (pas « #1156 »).
  const digits = search.replace(/\D/g, '');
  if (PHONE_LIKE.test(search) && digits.length >= 4 && digits !== search) {
    clauses.push(...PHONE_FIELDS.map(field => ({ [field]: containsInsensitive(digits) })));
  }

  return { $or: clauses };
};

export const buildOrderListFilters = (query: Pick<Request, 'query'>['query']) => {
  const status = toStringFilter(query.status);
  const customerConfirmationStatus = toStringFilter(query.customerConfirmationStatus);
  const operationalStatus = toStringFilter(query.operationalStatus);
  const orderName = toStringFilter(query.orderName);
  const phone = toStringFilter(query.phone);
  const search = toStringFilter(query.search);
  const cod = toStringFilter(query.cod);
  const hideCompleted = toStringFilter(query.hideCompleted);
  const hideCancelled = toStringFilter(query.hideCancelled);

  const filters: Record<string, unknown> = {};
  // Chaque groupe `$or` va sous `$and` : deux `$or` au même niveau s'écraseraient.
  const andClauses: Record<string, unknown>[] = [];

  if (status && Object.values(NotificationStatus).includes(status as NotificationStatus)) {
    filters.notificationStatus = status;
  }

  if (
    customerConfirmationStatus &&
    Object.values(CustomerConfirmationStatus).includes(customerConfirmationStatus as CustomerConfirmationStatus)
  ) {
    filters.customerConfirmationStatus = customerConfirmationStatus;
  }

  if (operationalStatus && Object.values(OrderOperationalStatus).includes(operationalStatus as OrderOperationalStatus)) {
    filters.operationalStatus = operationalStatus;
  }

  if (orderName) {
    filters.shopifyOrderName = { $regex: escapeRegExp(orderName), $options: 'i' };
  }

  if (phone) {
    andClauses.push({ $or: PHONE_FIELDS.map(field => ({ [field]: containsInsensitive(phone) })) });
  }

  if (search) {
    andClauses.push(buildSearchClause(search));
  }

  if (andClauses.length) {
    filters.$and = andClauses;
  }

  if (cod === 'true' || cod === 'false') {
    filters.isCashOnDelivery = cod === 'true';
  }

  // Un filtre de confirmation explicite (y compris « cancelled ») l'emporte sur le masquage.
  if (hideCancelled === 'true' && !filters.customerConfirmationStatus) {
    filters.customerConfirmationStatus = { $ne: CustomerConfirmationStatus.CANCELLED };
  }

  // Désencombrement : exclut les commandes dont tout le process est terminé
  // (livrée ET intégralement encaissée). Les livrées impayées/partielles restent visibles.
  if (hideCompleted === 'true') {
    filters.$nor = [
      { operationalStatus: OrderOperationalStatus.DELIVERED, codPaymentStatus: CodPaymentStatus.PAID }
    ];
  }

  return {
    filters,
    status,
    customerConfirmationStatus,
    operationalStatus,
    orderName,
    phone,
    search,
    cod,
    hideCompleted,
    hideCancelled
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

const firstNonEmpty = (...values: Array<string | null | undefined>) => {
  return values.find(value => typeof value === 'string' && value.trim().length > 0)?.trim();
};

const getOrderNoteAttribute = (order: IOrder, ...names: string[]) => {
  const attributes = order.noteAttributes;
  if (!attributes || typeof attributes !== 'object') return undefined;

  for (const name of names) {
    const value = attributes[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }

  return undefined;
};

type PopulatedActor = { _id: Types.ObjectId; userName?: string };

/**
 * Événement de timeline avec `actorId` peuplé (`populate('actorId', 'userName')`) :
 * on renvoie l'id à plat + `actorName`, attendus par le front. Un auteur supprimé
 * est peuplé à `null` et ressort sans id ni nom.
 */
export const toOrderEventResponse = (event: IOrderEvent) => {
  const actor = event.actorId as unknown as PopulatedActor | null | undefined;

  return {
    ...event.toJSON(),
    actorId: actor?._id?.toString(),
    actorName: actor?.userName
  };
};

/**
 * Reconstitue les champs de livraison des anciennes commandes qui ne
 * possèdent que les note_attributes Easysell.
 */
export const toOrderResponse = (order: IOrder) => {
  const serialized =
    typeof order.toJSON === 'function'
      ? order.toJSON()
      : { ...order, id: order._id.toString() };
  const rawRegion = firstNonEmpty(
    order.deliveryRegion,
    order.shippingRegion,
    getOrderNoteAttribute(order, 'Région', 'Region')
  );
  const canonicalRegion = resolveRegion(rawRegion);
  const region = canonicalRegion?.label || rawRegion;

  return {
    ...serialized,
    deliveryRegion: region,
    deliveryRegionCode: order.deliveryRegionCode || canonicalRegion?.code,
    shippingRegion: order.shippingRegion || region,
    deliveryAddress: firstNonEmpty(
      order.deliveryAddress,
      getOrderNoteAttribute(order, 'Adresse de livraison'),
      getOrderNoteAttribute(order, 'Adresse', 'Address')
    ),
    deliveryPreferredMoment: firstNonEmpty(
      order.deliveryPreferredMoment,
      getOrderNoteAttribute(order, 'Moment de livraison préféré')
    ),
    capabilities: getOrderActionCapabilities(order)
  };
};

export const toAttentionOrder = (order: IOrder) => {
  const normalizedOrder = toOrderResponse(order);

  return {
    id: order._id.toString(),
    orderName: order.shopifyOrderName,
    customerName: order.customerName || 'Client non renseigné',
    customerPhone: order.customerPhoneE164 || order.customerPhoneRaw || '',
    region: normalizedOrder.deliveryRegion || normalizedOrder.shippingRegion || 'Non renseignée',
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
  };
};

export class OrderController {
  public static async bulkConfirm(req: Request, res: Response) {
    const orderIds = parseBulkOrderIds(req.body?.orderIds);
    if (!orderIds) return res.status(400).json({ error: 'InvalidOrderIds' });

    const results = await runWithConcurrency(orderIds, orderId =>
      OrderConfirmationService.confirmByAdmin(orderId, req.userId)
    );
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

    const results = await runWithConcurrency(orderIds, orderId =>
      OrderConfirmationService.remindByAdmin(orderId, req.userId)
    );
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

    const openOrdersFilter = {
      needsHelpdeskAttention: true,
      operationalStatus: { $nin: [OrderOperationalStatus.DELIVERED, OrderOperationalStatus.RETURNED] },
      customerConfirmationStatus: { $ne: CustomerConfirmationStatus.CANCELLED }
    };

    const filters: Record<string, unknown> = {
      ...openOrdersFilter,
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
            ...openOrdersFilter,
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
        late_confirm: 0,
        unreachable: 0,
        phone_mismatch: 0
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
    const {
      filters,
      status,
      customerConfirmationStatus,
      operationalStatus,
      orderName,
      phone,
      search,
      cod,
      hideCancelled
    } = buildOrderListFilters(req.query);

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
        operationalStatus,
        hasOrderNameFilter: Boolean(orderName),
        hasPhoneFilter: Boolean(phone),
        hasSearchFilter: Boolean(search),
        hasCodFilter: cod === 'true' || cod === 'false',
        hideCancelled: hideCancelled === 'true'
      },
      'Listed orders'
    );

    return res.status(200).json({
      data: orders.map(toOrderResponse),
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

    const [messages, events] = await Promise.all([
      Message.find({ orderId: order._id }).sort({ createdAt: -1 }),
      OrderEvent.find({ orderId: order._id }).sort({ createdAt: -1 }).populate('actorId', 'userName')
    ]);
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
        order: toOrderResponse(order),
        messages,
        messageSummary,
        events: events.map(toOrderEventResponse),
        capabilities: getOrderActionCapabilities(order)
      }
    });
  }

  public static async confirm(req: Request, res: Response) {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    const source = parseConfirmationSource(req.body?.source);
    if (!source.ok) return res.status(400).json({ error: 'InvalidConfirmationSource' });

    try {
      const result = await OrderConfirmationService.confirmByAdmin(id, req.userId, source.value);

      log.info(
        {
          orderId: result.order._id,
          messageId: result.message._id,
          jobId: result.job.id,
          source: source.value
        },
        'Admin confirmed order'
      );

      return res.status(202).json({
        data: {
          order: toOrderResponse(result.order),
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
      const result = await OrderConfirmationService.cancelByAdmin(id, reason, req.userId);

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
          order: toOrderResponse(result.order),
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
      const result = await OrderConfirmationService.remindByAdmin(id, req.userId);

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
          order: toOrderResponse(result.order),
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

  public static async dispatch(req: Request, res: Response) {
    const id = typeof req.params.id === 'string' ? req.params.id : '';

    try {
      const order = await OrderFulfillmentService.dispatch(
        id,
        {
          channel: req.body?.channel as DeliveryChannel,
          courierId: typeof req.body?.courierId === 'string' ? req.body.courierId : undefined,
          carrierId: typeof req.body?.carrierId === 'string' ? req.body.carrierId : undefined,
          trackingNumber: typeof req.body?.trackingNumber === 'string' ? req.body.trackingNumber : undefined
        },
        req.userId
      );

      return res.status(200).json({ data: { order: toOrderResponse(order) } });
    } catch (err) {
      if (err instanceof OrderFulfillmentError) {
        return res.status(err.status).json({ error: err.code });
      }

      throw err;
    }
  }

  public static async deliver(req: Request, res: Response) {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    const collectedAmount = parseOptionalAmount(req.body?.collectedAmount);
    if (!collectedAmount.ok) return res.status(400).json({ error: 'InvalidCollectedAmount' });

    const courierFee = parseOptionalAmount(req.body?.courierFee);
    if (!courierFee.ok) return res.status(400).json({ error: 'InvalidCourierFee' });

    const carrierFee = parseOptionalAmount(req.body?.carrierFee);
    if (!carrierFee.ok) return res.status(400).json({ error: 'InvalidCarrierFee' });

    try {
      const order = await OrderFulfillmentService.deliver(
        id,
        {
          collectedAmount: collectedAmount.value,
          courierFee: courierFee.value,
          carrierFee: carrierFee.value,
          note: typeof req.body?.note === 'string' ? req.body.note : undefined
        },
        req.userId
      );

      return res.status(200).json({ data: { order: toOrderResponse(order) } });
    } catch (err) {
      if (err instanceof OrderFulfillmentError) {
        return res.status(err.status).json({ error: err.code });
      }

      throw err;
    }
  }

  public static async markDeliveryFailed(req: Request, res: Response) {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;

    try {
      const order = await OrderFulfillmentService.markDeliveryFailed(id, reason, req.userId);

      return res.status(200).json({ data: { order: toOrderResponse(order) } });
    } catch (err) {
      if (err instanceof OrderFulfillmentError) {
        return res.status(err.status).json({ error: err.code });
      }

      throw err;
    }
  }

  public static async markReturned(req: Request, res: Response) {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;

    try {
      const order = await OrderFulfillmentService.markReturned(id, reason, req.userId);

      return res.status(200).json({ data: { order: toOrderResponse(order) } });
    } catch (err) {
      if (err instanceof OrderFulfillmentError) {
        return res.status(err.status).json({ error: err.code });
      }

      throw err;
    }
  }

  public static async markUnreachable(req: Request, res: Response) {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    const note = typeof req.body?.note === 'string' ? req.body.note : undefined;

    try {
      const { order, event } = await OrderConfirmationService.markUnreachable(id, note, req.userId);

      log.info({ orderId: order._id, hasNote: Boolean(note?.trim()) }, 'Admin marked order unreachable');

      return res.status(200).json({ data: { order: toOrderResponse(order), event } });
    } catch (err) {
      if (err instanceof OrderConfirmationError) {
        return res.status(err.status).json({ error: err.code });
      }

      throw err;
    }
  }

  public static async addNote(req: Request, res: Response) {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    const text = typeof req.body?.text === 'string' ? req.body.text : undefined;

    try {
      const { order, event } = await OrderFulfillmentService.addNote(id, text, req.userId);

      return res.status(201).json({ data: { order: toOrderResponse(order), event } });
    } catch (err) {
      if (err instanceof OrderFulfillmentError) {
        return res.status(err.status).json({ error: err.code });
      }

      throw err;
    }
  }

  public static async reconciliation(req: Request, res: Response) {
    try {
      const summary = await ReconciliationService.summarize({
        date: typeof req.query.date === 'string' ? req.query.date : undefined,
        courierId: typeof req.query.courierId === 'string' ? req.query.courierId : undefined
      });

      return res.status(200).json({ data: summary });
    } catch (err) {
      if (err instanceof ReconciliationError) {
        return res.status(err.status).json({ error: err.code });
      }

      throw err;
    }
  }
}
