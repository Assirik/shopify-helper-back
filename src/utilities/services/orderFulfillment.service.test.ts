import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import { Carrier } from '../../models/Carrier';
import { Courier } from '../../models/Courier';
import { OrderEvent } from '../../models/OrderEvent';
import { CodPaymentStatus, DeliveryChannel, Order, OrderOperationalStatus } from '../../models/Order';
import { DeliveryFeeConfigService } from './deliveryFeeConfig.service';
import { OrderFulfillmentError, OrderFulfillmentService } from './orderFulfillment.service';

afterEach(() => {
  jest.restoreAllMocks();
});

const orderId = new Types.ObjectId();
const courierId = new Types.ObjectId();

describe('order fulfillment service', () => {
  it('dispatches a to_deliver order to an active internal courier', async () => {
    const updatedOrder = {
      _id: orderId,
      operationalStatus: OrderOperationalStatus.IN_DELIVERY,
      deliveryChannel: DeliveryChannel.INTERNAL,
      assignedCourierId: courierId
    };

    jest.spyOn(Courier, 'findById').mockResolvedValue({ _id: courierId, isActive: true } as never);
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue(updatedOrder as never);
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await expect(
      OrderFulfillmentService.dispatch(
        orderId.toString(),
        { channel: DeliveryChannel.INTERNAL, courierId: courierId.toString() },
        new Types.ObjectId().toString()
      )
    ).resolves.toBe(updatedOrder);

    expect(update.mock.calls[0]?.[0]).toEqual({
      _id: orderId.toString(),
      operationalStatus: { $in: [OrderOperationalStatus.TO_DELIVER, OrderOperationalStatus.DELIVERY_FAILED] }
    });
    expect(update.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        $set: expect.objectContaining({
          operationalStatus: OrderOperationalStatus.IN_DELIVERY,
          deliveryChannel: DeliveryChannel.INTERNAL,
          assignedCourierId: courierId
        })
      })
    );
  });

  it('blocks dispatch from an invalid operational status', async () => {
    jest.spyOn(Courier, 'findById').mockResolvedValue({ _id: courierId, isActive: true } as never);
    jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue(null);
    jest.spyOn(Order, 'exists').mockResolvedValue({ _id: orderId } as never);

    await expect(
      OrderFulfillmentService.dispatch(orderId.toString(), {
        channel: DeliveryChannel.INTERNAL,
        courierId: courierId.toString()
      })
    ).rejects.toMatchObject({ code: 'OrderDispatchNotAllowed', status: 409 });
  });

  it('requires an active courier for internal dispatch', async () => {
    jest.spyOn(Courier, 'findById').mockResolvedValue({ _id: courierId, isActive: false } as never);

    await expect(
      OrderFulfillmentService.dispatch(orderId.toString(), {
        channel: DeliveryChannel.INTERNAL,
        courierId: courierId.toString()
      })
    ).rejects.toMatchObject({ code: 'CourierInactive', status: 409 });
  });

  it.each([
    [25000, 25000, CodPaymentStatus.PAID],
    [12000, 25000, CodPaymentStatus.PARTIAL],
    [0, 25000, CodPaymentStatus.UNPAID]
  ])(
    'delivers an internal order and records COD status %s/%s as %s',
    async (collectedAmount, expectedAmount, paymentStatus) => {
      const currentOrder = {
        _id: orderId,
        totalPrice: String(expectedAmount),
        deliveryRegionCode: 'SN_DK',
        deliveryChannel: DeliveryChannel.INTERNAL,
        assignedCourierId: courierId,
        operationalStatus: OrderOperationalStatus.IN_DELIVERY
      };
      const updatedOrder = { ...currentOrder, operationalStatus: OrderOperationalStatus.DELIVERED };

      jest.spyOn(Order, 'findById').mockResolvedValue(currentOrder as never);
      jest.spyOn(DeliveryFeeConfigService, 'resolveDeliveryFee').mockResolvedValue(1500);
      const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue(updatedOrder as never);
      jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

      await expect(
        OrderFulfillmentService.deliver(orderId.toString(), { collectedAmount })
      ).resolves.toEqual(updatedOrder);

      expect(update.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({
          $set: expect.objectContaining({
            codExpectedAmount: expectedAmount,
            codCollectedAmount: collectedAmount,
            courierFeeAmount: 1500,
            carrierFeeAmount: 0,
            codNetRemitted: collectedAmount - 1500,
            codPaymentStatus: paymentStatus,
            operationalStatus: OrderOperationalStatus.DELIVERED
          })
        })
      );
    }
  );

  it('delivers a carrier order: deducts both courier remuneration and carrier cost from net', async () => {
    const carrierId = new Types.ObjectId();
    const currentOrder = {
      _id: orderId,
      totalPrice: '25000',
      deliveryRegionCode: 'SN_ZG',
      deliveryChannel: DeliveryChannel.CARRIER,
      assignedCourierId: courierId,
      assignedCarrierId: carrierId,
      shippingPrice: '2000',
      operationalStatus: OrderOperationalStatus.IN_DELIVERY
    };
    const updatedOrder = { ...currentOrder, operationalStatus: OrderOperationalStatus.DELIVERED };

    jest.spyOn(Order, 'findById').mockResolvedValue(currentOrder as never);
    // Pas de defaultPrice transporteur -> repli sur shippingPrice (2000).
    jest.spyOn(Carrier, 'findById').mockResolvedValue({ _id: carrierId } as never);
    jest.spyOn(DeliveryFeeConfigService, 'resolveDeliveryFee').mockResolvedValue(1500);
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue(updatedOrder as never);
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await OrderFulfillmentService.deliver(orderId.toString(), {});

    expect(update.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        $set: expect.objectContaining({
          courierFeeAmount: 1500,
          carrierFeeAmount: 2000,
          codNetRemitted: 25000 - 1500 - 2000
        })
      })
    );
  });

  it('blocks deliver from any status other than in_delivery', async () => {
    jest.spyOn(Order, 'findById').mockResolvedValue({
      _id: orderId,
      totalPrice: '25000',
      operationalStatus: OrderOperationalStatus.TO_DELIVER
    } as never);

    await expect(OrderFulfillmentService.deliver(orderId.toString(), {})).rejects.toMatchObject({
      code: 'OrderDeliverNotAllowed',
      status: 409
    });
  });

  it('rejects invalid collected amounts', async () => {
    jest.spyOn(Order, 'findById').mockResolvedValue({
      _id: orderId,
      totalPrice: '25000',
      operationalStatus: OrderOperationalStatus.IN_DELIVERY
    } as never);

    await expect(OrderFulfillmentService.deliver(orderId.toString(), { collectedAmount: -1 })).rejects.toBeInstanceOf(
      OrderFulfillmentError
    );
  });

  it('marks active deliveries as failed and increments attempts', async () => {
    jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({
      _id: orderId,
      operationalStatus: OrderOperationalStatus.DELIVERY_FAILED
    } as never);
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await OrderFulfillmentService.markDeliveryFailed(orderId.toString(), 'Client absent');

    expect((Order.findOneAndUpdate as unknown as jest.Mock).mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        $set: expect.objectContaining({ operationalStatus: OrderOperationalStatus.DELIVERY_FAILED }),
        $inc: { deliveryAttempts: 1 }
      })
    );
  });

  it('marks in_delivery or delivery_failed orders as returned', async () => {
    jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({
      _id: orderId,
      operationalStatus: OrderOperationalStatus.RETURNED
    } as never);
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await OrderFulfillmentService.markReturned(orderId.toString(), 'Retour client');

    expect((Order.findOneAndUpdate as unknown as jest.Mock).mock.calls[0]?.[0]).toEqual({
      _id: orderId.toString(),
      operationalStatus: { $in: [OrderOperationalStatus.IN_DELIVERY, OrderOperationalStatus.DELIVERY_FAILED] }
    });
  });
});
