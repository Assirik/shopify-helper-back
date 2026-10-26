import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { AttentionReasonCode, ConfirmationSource, CustomerConfirmationStatus, IOrder } from '../models/Order';
import {
  OrderController,
  buildOrderListFilters,
  parseBulkOrderIds,
  parseConfirmationSource,
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
          canReturn: false,
          canMarkUnreachable: true
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

  const phoneClause = {
    $or: [
      { customerPhoneE164: { $regex: '771234567', $options: 'i' } },
      { customerPhoneRaw: { $regex: '771234567', $options: 'i' } }
    ]
  };

  it('searches every supported field in a single $or nested under $and', () => {
    const { filters } = buildOrderListFilters({ search: '  awa  ' });
    const fields = [
      'shopifyOrderName',
      'customerName',
      'customerPhoneE164',
      'customerPhoneRaw',
      'customerEmail',
      'tags',
      'lineItems.title',
      'lineItems.sku'
    ];

    expect(filters).toEqual({
      $and: [{ $or: fields.map(field => ({ [field]: { $regex: 'awa', $options: 'i' } })) }]
    });
  });

  it.each([
    [{ phone: '771234567' }, [phoneClause]],
    [{ phone: '771234567', search: 'awa' }, [phoneClause, expect.objectContaining({ $or: expect.any(Array) })]]
  ])('keeps the phone filter alongside the search for %p', (query, expected) => {
    const { filters } = buildOrderListFilters(query);

    expect(filters.$or).toBeUndefined();
    expect(filters.$and).toEqual(expected);
  });

  it('escapes regex special characters in the search', () => {
    const { filters } = buildOrderListFilters({ search: '#1156 (a+b)' });
    const [clause] = filters.$and as { $or: Record<string, { $regex: string }>[] }[];

    expect(clause?.$or[0]).toEqual({ shopifyOrderName: { $regex: '#1156 \\(a\\+b\\)', $options: 'i' } });
  });

  it('also matches phones on digits only when the search is typed with spaces', () => {
    const { filters } = buildOrderListFilters({ search: '77 412 88 90' });
    const [clause] = filters.$and as { $or: Record<string, unknown>[] }[];

    expect(clause?.$or).toEqual(
      expect.arrayContaining([
        { customerPhoneE164: { $regex: '774128890', $options: 'i' } },
        { customerPhoneRaw: { $regex: '774128890', $options: 'i' } }
      ])
    );
  });

  it.each(['awa', '#1156', '1156', 'SKU-2024-01'])('does not add a digits-only phone clause to %p', search => {
    const { filters } = buildOrderListFilters({ search });
    const [clause] = filters.$and as { $or: unknown[] }[];

    expect(clause?.$or).toHaveLength(8);
  });

  it.each([
    [{ hideCancelled: 'true' }, { customerConfirmationStatus: { $ne: CustomerConfirmationStatus.CANCELLED } }],
    [{ hideCancelled: 'false' }, {}],
    [{}, {}],
    [
      { hideCancelled: 'true', customerConfirmationStatus: CustomerConfirmationStatus.CANCELLED },
      { customerConfirmationStatus: CustomerConfirmationStatus.CANCELLED }
    ],
    [
      { hideCancelled: 'true', customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED },
      { customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED }
    ],
    [
      { hideCancelled: 'true', customerConfirmationStatus: 'unknown' },
      { customerConfirmationStatus: { $ne: CustomerConfirmationStatus.CANCELLED } }
    ]
  ])('applies hideCancelled to %p', (query, expected) => {
    expect(buildOrderListFilters(query).filters).toEqual(expected);
  });

  it('combines search, hideCancelled and hideCompleted without overwriting each other', () => {
    const { filters } = buildOrderListFilters({ search: 'awa', hideCancelled: 'true', hideCompleted: 'true' });

    expect(filters).toEqual({
      $and: [expect.objectContaining({ $or: expect.any(Array) })],
      customerConfirmationStatus: { $ne: CustomerConfirmationStatus.CANCELLED },
      $nor: [{ operationalStatus: 'delivered', codPaymentStatus: 'paid' }]
    });
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

describe('order controller confirmation source parsing', () => {
  it('defaults to admin when the source is omitted', () => {
    expect(parseConfirmationSource(undefined)).toEqual({ ok: true, value: ConfirmationSource.ADMIN });
  });

  it.each([ConfirmationSource.ADMIN, ConfirmationSource.PHONE_CALL])('accepts %p', source => {
    expect(parseConfirmationSource(source)).toEqual({ ok: true, value: source });
  });

  it.each([ConfirmationSource.WHATSAPP_BUTTON, 'sms', '', null, 42])('rejects %p', source => {
    expect(parseConfirmationSource(source)).toEqual({ ok: false });
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
