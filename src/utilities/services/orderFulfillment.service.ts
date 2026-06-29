import { Types } from 'mongoose';
import { Courier } from '../../models/Courier';
import { OrderEvent, OrderEventType } from '../../models/OrderEvent';
import {
  CodPaymentStatus,
  DeliveryChannel,
  Order,
  OrderOperationalStatus
} from '../../models/Order';
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
  trackingNumber?: string;
}

export interface DeliverOrderInput {
  collectedAmount?: number;
  courierFee?: number;
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
      if (!input.courierId || !Types.ObjectId.isValid(input.courierId)) {
        throw new OrderFulfillmentError('CourierRequired', 'An active courier is required', 400);
      }

      const courier = await Courier.findById(input.courierId);
      if (!courier) {
        throw new OrderFulfillmentError('CourierNotFound', 'Courier not found', 404);
      }
      if (!courier.isActive) {
        throw new OrderFulfillmentError('CourierInactive', 'Courier is inactive', 409);
      }

      update.assignedCourierId = courier._id;
      unset.carrierTrackingNumber = '';
      metadata.courierId = courier._id.toString();
    } else {
      update.carrierTrackingNumber = input.trackingNumber?.trim() || undefined;
      unset.assignedCourierId = '';
      metadata.trackingNumber = input.trackingNumber?.trim();
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

    const courierFeeAmount = input.courierFee ?? (await DeliveryFeeConfigService.resolveDeliveryFee(currentOrder.deliveryRegionCode));
    ensureMoneyAmount(courierFeeAmount, 'InvalidCourierFee');

    const codNetRemitted = codCollectedAmount - courierFeeAmount;
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
    ensureObjectId(orderId);

    const order = await Order.findOneAndUpdate(
      {
        _id: orderId,
        operationalStatus: { $in: [OrderOperationalStatus.IN_DELIVERY, OrderOperationalStatus.DELIVERY_FAILED] }
      },
      {
        $set: {
          operationalStatus: OrderOperationalStatus.RETURNED,
          deliveryFailureReason: trimmedReason
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
