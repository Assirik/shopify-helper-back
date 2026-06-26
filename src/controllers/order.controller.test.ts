import { describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import { AttentionReasonCode, CustomerConfirmationStatus, IOrder } from '../models/Order';
import { parseBulkOrderIds, toAttentionOrder } from './order.controller';

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
        capabilities: { canConfirm: true, canRemind: false, canCancel: true }
      })
    );
  });
});
