import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { AttentionReasonCode, CustomerConfirmationStatus, IOrder } from '../models/Order';
import {
  OrderController,
  buildOrderListFilters,
  parseBulkOrderIds,
  parseOptionalAmount,
  toAttentionOrder,
  toOrderEventResponse,
  toOrderResponse
} from './order.controller';
import { IOrderEvent, OrderEventType } from '../models/OrderEvent';
import { OrderConfirmationService } from '../utilities/services/orderConfirmation.service';

jest.mock('../queues/notification.queue', () => ({
  enqueueConfirmationReminder: jest.fn(),
  enqueueOrderCancelled: jest.fn(),
  enqueueOrderConfirmed: jest.fn()
}));

describe('order controller attention contracts', () => {
  it('accepts a bounded list of unique ObjectIds', () => {
    const ids = [new Types.ObjectId().toString(), new Types.ObjectId().toString()];
    expect(parseBulkOrderIds(ids)).toEqual(ids);
  });

  it('restores delivery fields from legacy Easysell note attributes', () => {
    const order = {
      _id: new Types.ObjectId(),
      shopifyOrderName: '#1128',
      noteAttributes: {
        Région: 'Dakar',
        'Adresse de livraison': 'Mbao',
        'Moment de livraison préféré': 'Matinée'
      }
    } as unknown as IOrder;

    expect(toOrderResponse(order)).toEqual(
      expect.objectContaining({
        deliveryRegion: 'Dakar',
        deliveryRegionCode: 'SN_DK',
        shippingRegion: 'Dakar',
        deliveryAddress: 'Mbao',
        deliveryPreferredMoment: 'Matinée'
      })
    );
  });

  it.each([undefined, [], ['invalid'], [new Types.ObjectId().toString(), new Types.ObjectId().toString()].flatMap(id => [id, id])])(
    'rejects invalid bulk IDs %p',
    value => {
      expect(parseBulkOrderIds(value)).toBeUndefined();
    }
  );

  it('maps an Order to the minimal attention DTO with capabilities', () => {
    const now = new Date();
    const order = {
      _id: new Types.ObjectId(),
      shopifyOrderName: '#10428',
      customerName: 'Awa Diop',
      customerPhoneE164: '+221774128890',
      deliveryRegion: 'Dakar',
      totalPrice: '18500',
      currency: 'XOF',
      isCashOnDelivery: true,
      attentionReasonCode: AttentionReasonCode.FREE_TEXT,
      attentionRequiredAt: now,
      lastCustomerMessageText: 'Le bleu est disponible ?',
      customerConfirmationStatus: CustomerConfirmationStatus.NEEDS_ATTENTION,
      reminderCount: 0,
      createdAt: now,
      updatedAt: now
    } as IOrder;

    expect(toAttentionOrder(order)).toEqual(
      expect.objectContaining({
        id: order._id.toString(),
        orderName: '#10428',
        reason: AttentionReasonCode.FREE_TEXT,
        receivedAt: now,
        capabilities: {
          canConfirm: true,
          canRemind: false,
          canCancel: true,
          canDispatch: false,
          canDeliver: false,
          canMarkFailed: false,
          canReturn: false
        }
      })
    );
  });
});

describe('order controller list filters', () => {
  it('filters COD orders when cod=true', () => {
    expect(buildOrderListFilters({ cod: 'true' }).filters).toEqual({ isCashOnDelivery: true });
  });

  it('filters non-COD orders when cod=false', () => {
    expect(buildOrderListFilters({ cod: 'false' }).filters).toEqual({ isCashOnDelivery: false });
  });

  it('ignores invalid COD filter values', () => {
    expect(buildOrderListFilters({ cod: 'yes' }).filters).toEqual({});
  });

  it('combines COD and customer confirmation filters', () => {
    expect(
      buildOrderListFilters({
        cod: 'true',
        customerConfirmationStatus: CustomerConfirmationStatus.NEEDS_ATTENTION
      }).filters
    ).toEqual({
      isCashOnDelivery: true,
      customerConfirmationStatus: CustomerConfirmationStatus.NEEDS_ATTENTION
    });
  });

  it('filters operational statuses', () => {
    expect(buildOrderListFilters({ operationalStatus: 'to_deliver' }).filters).toEqual({
      operationalStatus: 'to_deliver'
    });
  });

  it('excludes completed orders (delivered & paid) when hideCompleted=true', () => {
    expect(buildOrderListFilters({ hideCompleted: 'true' }).filters).toEqual({
      $nor: [{ operationalStatus: 'delivered', codPaymentStatus: 'paid' }]
    });
  });

  it('keeps completed orders unless hideCompleted is explicitly true', () => {
    expect(buildOrderListFilters({ hideCompleted: 'false' }).filters).toEqual({});
    expect(buildOrderListFilters({}).filters).toEqual({});
  });
});

describe('order controller optional amount parsing', () => {
  it('treats an omitted value as a service-side fallback', () => {
    expect(parseOptionalAmount(undefined)).toEqual({ ok: true, value: undefined });
  });

  it('accepts a finite non-negative number', () => {
    expect(parseOptionalAmount(25000)).toEqual({ ok: true, value: 25000 });
    expect(parseOptionalAmount(0)).toEqual({ ok: true, value: 0 });
  });

  it.each([null, '', '   ', 'abc', -1, NaN, {}])('rejects the invalid amount %p', value => {
    expect(parseOptionalAmount(value)).toEqual({ ok: false });
  });
});

describe('order controller timeline events', () => {
  const buildEvent = (actorId: unknown) =>
    ({
      actorId,
      toJSON: () => ({ type: OrderEventType.NOTE, note: 'Livrer chez son frère', actorId })
    }) as unknown as IOrderEvent;

  it('flattens a populated author into actorId and actorName', () => {
    const userId = new Types.ObjectId();

    expect(toOrderEventResponse(buildEvent({ _id: userId, userName: 'awa' }))).toEqual(
      expect.objectContaining({ note: 'Livrer chez son frère', actorId: userId.toString(), actorName: 'awa' })
    );
  });

  it.each([null, undefined])('leaves the author empty when the actor is %p', actorId => {
    expect(toOrderEventResponse(buildEvent(actorId))).toEqual(
      expect.objectContaining({ actorId: undefined, actorName: undefined })
    );
  });
});

describe('order controller bulk actions', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const buildBulkCall = (orderIds: string[]) => {
    const userId = new Types.ObjectId().toString();
    const req = { body: { orderIds }, userId } as unknown as Request;
    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })) } as unknown as Response;
    return { req, res, userId };
  };

  it.each([
    ['bulkConfirm', 'confirmByAdmin'],
    ['bulkRemind', 'remindByAdmin']
  ] as const)('%s records the acting user as the author of every order event', async (handler, serviceMethod) => {
    const orderIds = [new Types.ObjectId().toString(), new Types.ObjectId().toString()];
    const service = jest.spyOn(OrderConfirmationService, serviceMethod).mockResolvedValue({} as never);
    const { req, res, userId } = buildBulkCall(orderIds);

    await OrderController[handler](req, res);

    expect(service).toHaveBeenCalledTimes(orderIds.length);
    orderIds.forEach(orderId => expect(service).toHaveBeenCalledWith(orderId, userId));
  });
});
