import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import { Carrier } from '../../models/Carrier';
import { Courier } from '../../models/Courier';
import { OrderEvent, OrderEventType } from '../../models/OrderEvent';
import { CodPaymentStatus, DeliveryChannel, Order, OrderOperationalStatus } from '../../models/Order';
import { DeliveryFeeConfigService } from './deliveryFeeConfig.service';
import { MAX_NOTE_LENGTH, OrderFulfillmentError, OrderFulfillmentService } from './orderFulfillment.service';

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

    jest
      .spyOn(Order, 'findById')
      .mockResolvedValue({ _id: orderId, operationalStatus: OrderOperationalStatus.TO_DELIVER } as never);
    jest.spyOn(Courier, 'findById').mockResolvedValue({ _id: courierId, isActive: true } as never);
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue(updatedOrder as never);
    const createEvent = jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

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
    // La timeline capture le statut d'origine réel (1re expédition vs réexpédition).
    expect(createEvent.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ fromStatus: OrderOperationalStatus.TO_DELIVER })
    );
  });

  it('blocks dispatch from an invalid operational status', async () => {
    jest
      .spyOn(Order, 'findById')
      .mockResolvedValue({ _id: orderId, operationalStatus: OrderOperationalStatus.DELIVERED } as never);
    jest.spyOn(Courier, 'findById').mockResolvedValue({ _id: courierId, isActive: true } as never);
    jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue(null);

    await expect(
      OrderFulfillmentService.dispatch(orderId.toString(), {
        channel: DeliveryChannel.INTERNAL,
        courierId: courierId.toString()
      })
    ).rejects.toMatchObject({ code: 'OrderDispatchNotAllowed', status: 409 });
  });

  it('requires an active courier for internal dispatch', async () => {
    jest
      .spyOn(Order, 'findById')
      .mockResolvedValue({ _id: orderId, operationalStatus: OrderOperationalStatus.TO_DELIVER } as never);
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
    [12000, 25000, CodPaymentStatus.PARTIAL]
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

  it('records an unpaid delivery (0 collected, no fee to deduct)', async () => {
    const currentOrder = {
      _id: orderId,
      totalPrice: '25000',
      deliveryChannel: DeliveryChannel.INTERNAL,
      operationalStatus: OrderOperationalStatus.IN_DELIVERY
    };
    const updatedOrder = { ...currentOrder, operationalStatus: OrderOperationalStatus.DELIVERED };

    jest.spyOn(Order, 'findById').mockResolvedValue(currentOrder as never);
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue(updatedOrder as never);
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await OrderFulfillmentService.deliver(orderId.toString(), { collectedAmount: 0 });

    expect(update.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        $set: expect.objectContaining({
          codCollectedAmount: 0,
          courierFeeAmount: 0,
          carrierFeeAmount: 0,
          codNetRemitted: 0,
          codPaymentStatus: CodPaymentStatus.UNPAID
        })
      })
    );
  });

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

  it('refuses to deliver when deducted fees exceed the collected amount', async () => {
    jest.spyOn(Order, 'findById').mockResolvedValue({
      _id: orderId,
      totalPrice: '25000',
      deliveryChannel: DeliveryChannel.INTERNAL,
      assignedCourierId: courierId,
      operationalStatus: OrderOperationalStatus.IN_DELIVERY
    } as never);
    const update = jest.spyOn(Order, 'findOneAndUpdate');

    await expect(
      OrderFulfillmentService.deliver(orderId.toString(), { collectedAmount: 1000, courierFee: 1500 })
    ).rejects.toMatchObject({ code: 'InvalidCourierFee', status: 400 });

    // Aucune écriture : pas de donnée incohérente persistée.
    expect(update).not.toHaveBeenCalled();
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

  it('marks in_delivery or delivery_failed orders as returned with a dedicated reason field', async () => {
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({
      _id: orderId,
      operationalStatus: OrderOperationalStatus.RETURNED
    } as never);
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await OrderFulfillmentService.markReturned(orderId.toString(), 'Retour client');

    expect(update.mock.calls[0]?.[0]).toEqual({
      _id: orderId.toString(),
      operationalStatus: { $in: [OrderOperationalStatus.IN_DELIVERY, OrderOperationalStatus.DELIVERY_FAILED] }
    });
    expect(update.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        $set: expect.objectContaining({
          operationalStatus: OrderOperationalStatus.RETURNED,
          returnReason: 'Retour client'
        })
      })
    );
  });

  it('requires a reason to mark an order returned', async () => {
    const update = jest.spyOn(Order, 'findOneAndUpdate');

    await expect(OrderFulfillmentService.markReturned(orderId.toString(), '  ')).rejects.toMatchObject({
      code: 'ReturnReasonRequired',
      status: 400
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('records a note event with its author and denormalizes the last note on the order', async () => {
    const actorId = new Types.ObjectId();
    const noteCreatedAt = new Date('2026-10-25T10:00:00.000Z');
    jest.spyOn(Order, 'exists').mockResolvedValue({ _id: orderId } as never);
    const createEvent = jest
      .spyOn(OrderEvent, 'create')
      .mockResolvedValue({ createdAt: noteCreatedAt } as never);
    const update = jest
      .spyOn(Order, 'findByIdAndUpdate')
      .mockResolvedValue({ _id: orderId, lastNoteText: 'Livrer chez son frère' } as never);

    await OrderFulfillmentService.addNote(orderId.toString(), '  Livrer chez son frère  ', actorId.toString());

    expect(createEvent.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ type: OrderEventType.NOTE, note: 'Livrer chez son frère', actorId })
    );
    // L'aperçu reprend l'horodatage de l'événement : liste et timeline affichent la même date.
    expect(update.mock.calls[0]?.[1]).toEqual({
      $set: { lastNoteText: 'Livrer chez son frère', lastNoteAt: noteCreatedAt }
    });
    expect(createEvent.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0] ?? 0);
  });

  it('requires a note text', async () => {
    const update = jest.spyOn(Order, 'findByIdAndUpdate');

    await expect(OrderFulfillmentService.addNote(orderId.toString(), '   ')).rejects.toMatchObject({
      code: 'NoteTextRequired',
      status: 400
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('accepts a note at the length limit and rejects a longer one', async () => {
    jest.spyOn(Order, 'exists').mockResolvedValue({ _id: orderId } as never);
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({ createdAt: new Date() } as never);
    const update = jest.spyOn(Order, 'findByIdAndUpdate').mockResolvedValue({ _id: orderId } as never);

    await OrderFulfillmentService.addNote(orderId.toString(), 'a'.repeat(MAX_NOTE_LENGTH));
    expect(update).toHaveBeenCalledTimes(1);

    await expect(
      OrderFulfillmentService.addNote(orderId.toString(), 'a'.repeat(MAX_NOTE_LENGTH + 1))
    ).rejects.toMatchObject({ code: 'NoteTextTooLong', status: 400 });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('returns OrderNotFound when noting an unknown order', async () => {
    jest.spyOn(Order, 'exists').mockResolvedValue(null as never);
    const createEvent = jest.spyOn(OrderEvent, 'create');

    await expect(OrderFulfillmentService.addNote(orderId.toString(), 'Reporter à samedi')).rejects.toMatchObject({
      code: 'OrderNotFound',
      status: 404
    });
    expect(createEvent).not.toHaveBeenCalled();
  });
});
