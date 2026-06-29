import { Types } from 'mongoose';
import { Carrier } from '../../models/Carrier';
import { Courier } from '../../models/Courier';
import { OrderEvent, OrderEventType } from '../../models/OrderEvent';
import {
  CodPaymentStatus,
  DeliveryChannel,
  IOrder,
  Order,
  OrderOperationalStatus
} from '../../models/Order';
import config from '../config/env.config';
import { DeliveryFeeConfigService } from './deliveryFeeConfig.service';

export class OrderFulfillmentError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'OrderFulfillmentError';
    this.code = code;
    this.status = status;
  }
}

export interface DispatchOrderInput {
  channel?: DeliveryChannel;
  courierId?: string;
  carrierId?: string;
  trackingNumber?: string;
}

export interface DeliverOrderInput {
  collectedAmount?: number;
  courierFee?: number;
  carrierFee?: number;
  note?: string;
}

const ensureObjectId = (orderId: string) => {
  if (!Types.ObjectId.isValid(orderId)) {
    throw new OrderFulfillmentError('OrderNotFound', 'Order not found', 404);
  }
};

const ensureActorId = (actorId?: string) => {
  return actorId && Types.ObjectId.isValid(actorId) ? new Types.ObjectId(actorId) : undefined;
};

const ensureMoneyAmount = (value: unknown, code: string) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new OrderFulfillmentError(code, 'Amount must be a positive number or zero', 400);
  }
};

const getCodPaymentStatus = (collected: number, expected: number) => {
  if (collected >= expected) return CodPaymentStatus.PAID;
  if (collected > 0) return CodPaymentStatus.PARTIAL;
  return CodPaymentStatus.UNPAID;
};

const createEvent = (input: {
  orderId: Types.ObjectId;
  type: OrderEventType;
  fromStatus?: OrderOperationalStatus;
  toStatus?: OrderOperationalStatus;
  actorId?: string;
  note?: string;
  metadata?: Record<string, unknown>;
}) => {
  return OrderEvent.create({
    orderId: input.orderId,
    type: input.type,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    actorId: ensureActorId(input.actorId),
    note: input.note,
    metadata: input.metadata
  });
};

const getOrderOrThrow = async (orderId: string) => {
  ensureObjectId(orderId);

  const order = await Order.findById(orderId);

  if (!order) {
    throw new OrderFulfillmentError('OrderNotFound', 'Order not found', 404);
  }

  return order;
};

const loadActiveCourier = async (courierId?: string) => {
  if (!courierId || !Types.ObjectId.isValid(courierId)) {
    throw new OrderFulfillmentError('CourierRequired', 'An active courier is required', 400);
  }

  const courier = await Courier.findById(courierId);
  if (!courier) {
    throw new OrderFulfillmentError('CourierNotFound', 'Courier not found', 404);
  }
  if (!courier.isActive) {
    throw new OrderFulfillmentError('CourierInactive', 'Courier is inactive', 409);
  }

  return courier;
};

const loadActiveCarrier = async (carrierId?: string) => {
  if (!carrierId || !Types.ObjectId.isValid(carrierId)) {
    throw new OrderFulfillmentError('CarrierRequired', 'A carrier is required', 400);
  }

  const carrier = await Carrier.findById(carrierId);
  if (!carrier) {
    throw new OrderFulfillmentError('CarrierNotFound', 'Carrier not found', 404);
  }
  if (!carrier.isActive) {
    throw new OrderFulfillmentError('CarrierInactive', 'Carrier is inactive', 409);
  }

  return carrier;
};

// Coût d'une livraison transporteur tiers (hors Dakar) : prix indicatif du transporteur,
// sinon le shipping facturé au client (déjà dans l'order), sinon le défaut de config.
const resolveCarrierFee = async (order: Pick<IOrder, 'assignedCarrierId' | 'shippingPrice'>) => {
  if (order.assignedCarrierId) {
    const carrier = await Carrier.findById(order.assignedCarrierId);
    if (carrier && typeof carrier.defaultPrice === 'number') {
      return carrier.defaultPrice;
    }
  }

  const shippingPrice = Number(order.shippingPrice);
  if (Number.isFinite(shippingPrice) && shippingPrice >= 0) {
    return shippingPrice;
  }

  return config.delivery.defaultCarrierFee;
};

export class OrderFulfillmentService {
  public static async dispatch(orderId: string, input: DispatchOrderInput, actorId?: string) {
    ensureObjectId(orderId);

    if (!Object.values(DeliveryChannel).includes(input.channel as DeliveryChannel)) {
      throw new OrderFulfillmentError('InvalidDeliveryChannel', 'Invalid delivery channel', 400);
    }

    const update: Record<string, unknown> = {
      operationalStatus: OrderOperationalStatus.IN_DELIVERY,
      deliveryChannel: input.channel,
      dispatchedAt: new Date()
    };
    const unset: Record<string, ''> = { deliveryFailureReason: '' };
    const metadata: Record<string, unknown> = { channel: input.channel };

    if (input.channel === DeliveryChannel.INTERNAL) {
      const courier = await loadActiveCourier(input.courierId);

      update.assignedCourierId = courier._id;
      unset.carrierTrackingNumber = '';
      unset.assignedCarrierId = '';
      metadata.courierId = courier._id.toString();
    } else {
      const carrier = await loadActiveCarrier(input.carrierId);

      update.assignedCarrierId = carrier._id;
      update.carrierTrackingNumber = input.trackingNumber?.trim() || undefined;
      metadata.carrierId = carrier._id.toString();
      metadata.trackingNumber = input.trackingNumber?.trim();

      // Livreur interne qui amène le colis au transporteur et détient le cash encaissé
      // (optionnel : il porte la rémunération livreur et apparaît au rapprochement caisse).
      if (input.courierId) {
        const courier = await loadActiveCourier(input.courierId);
        update.assignedCourierId = courier._id;
        metadata.courierId = courier._id.toString();
      } else {
        unset.assignedCourierId = '';
      }
    }

    const order = await Order.findOneAndUpdate(
      {
        _id: orderId,
        operationalStatus: { $in: [OrderOperationalStatus.TO_DELIVER, OrderOperationalStatus.DELIVERY_FAILED] }
      },
      {
        $set: update,
        $unset: unset
      },
      { new: true }
    );

    if (!order) {
      const exists = await Order.exists({ _id: orderId });
      if (!exists) {
        throw new OrderFulfillmentError('OrderNotFound', 'Order not found', 404);
      }
      throw new OrderFulfillmentError('OrderDispatchNotAllowed', 'Order cannot be dispatched from its current status', 409);
    }

    await createEvent({
      orderId: order._id,
      type: OrderEventType.DISPATCHED,
      fromStatus: undefined,
      toStatus: OrderOperationalStatus.IN_DELIVERY,
      actorId,
      metadata
    });

    return order;
  }

  public static async deliver(orderId: string, input: DeliverOrderInput, actorId?: string) {
    const currentOrder = await getOrderOrThrow(orderId);

    if (currentOrder.operationalStatus !== OrderOperationalStatus.IN_DELIVERY) {
      throw new OrderFulfillmentError('OrderDeliverNotAllowed', 'Order cannot be delivered from its current status', 409);
    }

    const expectedAmount = Number(currentOrder.totalPrice);
    const codExpectedAmount = Number.isFinite(expectedAmount) ? expectedAmount : 0;
    const codCollectedAmount = input.collectedAmount ?? codExpectedAmount;

    ensureMoneyAmount(codCollectedAmount, 'InvalidCollectedAmount');

    // Rémunération du livreur interne (barème région) : uniquement si un livreur est assigné.
    const courierFeeAmount =
      input.courierFee ??
      (currentOrder.assignedCourierId
        ? await DeliveryFeeConfigService.resolveDeliveryFee(currentOrder.deliveryRegionCode)
        : 0);
    ensureMoneyAmount(courierFeeAmount, 'InvalidCourierFee');

    // Coût du transporteur tiers : uniquement pour le canal carrier (hors Dakar).
    const carrierFeeAmount =
      currentOrder.deliveryChannel === DeliveryChannel.CARRIER
        ? input.carrierFee ?? (await resolveCarrierFee(currentOrder))
        : 0;
    ensureMoneyAmount(carrierFeeAmount, 'InvalidCarrierFee');

    const codNetRemitted = codCollectedAmount - courierFeeAmount - carrierFeeAmount;

    // Jamais de net négatif : on refuse plutôt que de persister une caisse incohérente.
    if (codNetRemitted < 0) {
      const code = courierFeeAmount > codCollectedAmount ? 'InvalidCourierFee' : 'InvalidCarrierFee';
      throw new OrderFulfillmentError(code, 'Deducted fees cannot exceed the collected amount', 400);
    }

    const codPaymentStatus = getCodPaymentStatus(codCollectedAmount, codExpectedAmount);
    const now = new Date();

    const order = await Order.findOneAndUpdate(
      { _id: orderId, operationalStatus: OrderOperationalStatus.IN_DELIVERY },
      {
        $set: {
          operationalStatus: OrderOperationalStatus.DELIVERED,
          codExpectedAmount,
          codCollectedAmount,
          courierFeeAmount,
          carrierFeeAmount,
          codNetRemitted,
          codPaymentStatus,
          deliveredAt: now,
          collectedAt: now
        }
      },
      { new: true }
    );

    if (!order) {
      throw new OrderFulfillmentError('OrderDeliverNotAllowed', 'Order cannot be delivered from its current status', 409);
    }

    const metadata = {
      expectedAmount: codExpectedAmount,
      collectedAmount: codCollectedAmount,
      courierFee: courierFeeAmount,
      carrierFee: carrierFeeAmount,
      netRemitted: codNetRemitted,
      codPaymentStatus
    };

    await Promise.all([
      createEvent({
        orderId: order._id,
        type: OrderEventType.DELIVERED,
        fromStatus: OrderOperationalStatus.IN_DELIVERY,
        toStatus: OrderOperationalStatus.DELIVERED,
        actorId,
        note: input.note,
        metadata
      }),
      createEvent({
        orderId: order._id,
        type: OrderEventType.PAYMENT_RECORDED,
        actorId,
        note: input.note,
        metadata
      })
    ]);

    return order;
  }

  public static async markDeliveryFailed(orderId: string, reason: string | undefined, actorId?: string) {
    const trimmedReason = reason?.trim();
    if (!trimmedReason) {
      throw new OrderFulfillmentError('DeliveryFailureReasonRequired', 'A delivery failure reason is required', 400);
    }

    ensureObjectId(orderId);

    const order = await Order.findOneAndUpdate(
      { _id: orderId, operationalStatus: OrderOperationalStatus.IN_DELIVERY },
      {
        $set: {
          operationalStatus: OrderOperationalStatus.DELIVERY_FAILED,
          deliveryFailureReason: trimmedReason
        },
        $inc: { deliveryAttempts: 1 }
      },
      { new: true }
    );

    if (!order) {
      const exists = await Order.exists({ _id: orderId });
      if (!exists) {
        throw new OrderFulfillmentError('OrderNotFound', 'Order not found', 404);
      }
      throw new OrderFulfillmentError(
        'OrderDeliveryFailureNotAllowed',
        'Order cannot be marked failed from its current status',
        409
      );
    }

    await createEvent({
      orderId: order._id,
      type: OrderEventType.DELIVERY_FAILED,
      fromStatus: OrderOperationalStatus.IN_DELIVERY,
      toStatus: OrderOperationalStatus.DELIVERY_FAILED,
      actorId,
      note: trimmedReason
    });

    return order;
  }

  public static async markReturned(orderId: string, reason: string | undefined, actorId?: string) {
    const trimmedReason = reason?.trim();
    if (!trimmedReason) {
      throw new OrderFulfillmentError('ReturnReasonRequired', 'A return reason is required', 400);
    }

    ensureObjectId(orderId);

    const order = await Order.findOneAndUpdate(
      {
        _id: orderId,
        operationalStatus: { $in: [OrderOperationalStatus.IN_DELIVERY, OrderOperationalStatus.DELIVERY_FAILED] }
      },
      {
        $set: {
          operationalStatus: OrderOperationalStatus.RETURNED,
          returnReason: trimmedReason
        }
      },
      { new: true }
    );

    if (!order) {
      const exists = await Order.exists({ _id: orderId });
      if (!exists) {
        throw new OrderFulfillmentError('OrderNotFound', 'Order not found', 404);
      }
      throw new OrderFulfillmentError('OrderReturnNotAllowed', 'Order cannot be returned from its current status', 409);
    }

    await createEvent({
      orderId: order._id,
      type: OrderEventType.RETURNED,
      toStatus: OrderOperationalStatus.RETURNED,
      actorId,
      note: trimmedReason
    });

    return order;
  }
}
