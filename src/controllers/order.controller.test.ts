import { describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import { AttentionReasonCode, CustomerConfirmationStatus, IOrder } from '../models/Order';
import { buildOrderListFilters, parseBulkOrderIds, toAttentionOrder, toOrderResponse } from './order.controller';

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
});
