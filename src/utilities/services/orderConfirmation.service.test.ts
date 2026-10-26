import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import { Message } from '../../models/Message';
import { OrderEvent, OrderEventType } from '../../models/OrderEvent';
import {
  AttentionReasonCode,
  ConfirmationSource,
  CustomerConfirmationStatus,
  Order,
  OrderOperationalStatus
} from '../../models/Order';
import config from '../config/env.config';
import { CONFIRMABLE_BY_ADMIN, getOrderActionCapabilities } from './orderCapabilities.service';
import { OrderConfirmationService } from './orderConfirmation.service';
import { MAX_NOTE_LENGTH } from './orderFulfillment.service';

jest.mock('../../queues/notification.queue', () => ({
  enqueueConfirmationReminder: jest.fn(),
  enqueueOrderCancelled: jest.fn(),
  enqueueOrderConfirmed: jest.fn()
}));

describe('order action capabilities', () => {
  it('allows all valid actions for a fresh pending order', () => {
    expect(
      getOrderActionCapabilities({
        customerConfirmationStatus: CustomerConfirmationStatus.PENDING,
        customerPhoneE164: '+221771234567',
        reminderCount: 0
      })
    ).toEqual({
      canConfirm: true,
      canRemind: true,
      canCancel: true,
      canDispatch: false,
      canDeliver: false,
      canMarkFailed: false,
      canReturn: false,
      canMarkUnreachable: true
    });
  });

  it('blocks a reminder during cooldown', () => {
    expect(
      getOrderActionCapabilities({
        customerConfirmationStatus: CustomerConfirmationStatus.PENDING,
        customerPhoneE164: '+221771234567',
        reminderCount: 1,
        lastReminderAt: new Date()
      }).canRemind
    ).toBe(false);
  });

  it('blocks reminders at the configured limit and repeated cancellation', () => {
    expect(
      getOrderActionCapabilities({
        customerConfirmationStatus: CustomerConfirmationStatus.CANCELLED,
        customerPhoneE164: '+221771234567',
        reminderCount: config.confirmation.maxReminders
      })
    ).toEqual({
      canConfirm: false,
      canRemind: false,
      canCancel: false,
      canDispatch: false,
      canDeliver: false,
      canMarkFailed: false,
      canReturn: false,
      canMarkUnreachable: false
    });
  });

  it.each([
    [CustomerConfirmationStatus.PENDING, true],
    [CustomerConfirmationStatus.NEEDS_ATTENTION, true],
    [CustomerConfirmationStatus.SMS_ONLY, true],
    [CustomerConfirmationStatus.EXPIRED, true],
    [CustomerConfirmationStatus.CONFIRMED, false],
    [CustomerConfirmationStatus.CANCELLED, false]
  ])('allows marking a %s order unreachable: %p', (customerConfirmationStatus, expected) => {
    expect(getOrderActionCapabilities({ customerConfirmationStatus, reminderCount: 0 }).canMarkUnreachable).toBe(
      expected
    );
  });

  it('exposes operational delivery capabilities from the backend status', () => {
    expect(
      getOrderActionCapabilities({
        customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED,
        reminderCount: 0,
        operationalStatus: OrderOperationalStatus.TO_DELIVER
      })
    ).toEqual(
      expect.objectContaining({
        canDispatch: true,
        canDeliver: false,
        canMarkFailed: false,
        canReturn: false
      })
    );

    expect(
      getOrderActionCapabilities({
        customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED,
        reminderCount: 0,
        operationalStatus: OrderOperationalStatus.IN_DELIVERY
      })
    ).toEqual(
      expect.objectContaining({
        canDispatch: false,
        canDeliver: true,
        canMarkFailed: true,
        canReturn: true
      })
    );
  });

  it('blocks cancellation for terminal operational statuses', () => {
    expect(
      getOrderActionCapabilities({
        customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED,
        reminderCount: 0,
        operationalStatus: OrderOperationalStatus.DELIVERED
      }).canCancel
    ).toBe(false);

    expect(
      getOrderActionCapabilities({
        customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED,
        reminderCount: 0,
        operationalStatus: OrderOperationalStatus.RETURNED
      }).canCancel
    ).toBe(false);
  });
});

describe('order cancellation guards', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns a dedicated code when cancelling a delivered order', async () => {
    jest.spyOn(Order, 'findById').mockResolvedValue({
      _id: '507f1f77bcf86cd799439011',
      customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED,
      operationalStatus: OrderOperationalStatus.DELIVERED
    } as never);

    await expect(
      OrderConfirmationService.cancelByAdmin('507f1f77bcf86cd799439011', 'Erreur')
    ).rejects.toMatchObject({ code: 'OrderCancellationNotAllowedAfterDelivery', status: 409 });
  });

  it('keeps the legacy code when the order is already cancelled', async () => {
    jest.spyOn(Order, 'findById').mockResolvedValue({
      _id: '507f1f77bcf86cd799439011',
      customerConfirmationStatus: CustomerConfirmationStatus.CANCELLED
    } as never);

    await expect(
      OrderConfirmationService.cancelByAdmin('507f1f77bcf86cd799439011', 'Erreur')
    ).rejects.toMatchObject({ code: 'OrderCancellationNotAllowed', status: 409 });
  });
});

describe('admin confirmation source', () => {
  const orderId = new Types.ObjectId();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const mockConfirmation = () => {
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({ _id: orderId } as never);
    const createEvent = jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);
    jest.spyOn(Message, 'create').mockResolvedValue({ _id: new Types.ObjectId() } as never);
    return { update, createEvent };
  };

  it.each([
    [undefined, ConfirmationSource.ADMIN],
    [ConfirmationSource.ADMIN, ConfirmationSource.ADMIN],
    [ConfirmationSource.PHONE_CALL, ConfirmationSource.PHONE_CALL]
  ] as const)('records source %p as %p on the order and the event', async (source, expected) => {
    const { update, createEvent } = mockConfirmation();

    await OrderConfirmationService.confirmByAdmin(orderId.toString(), undefined, source);

    expect(update.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ $set: expect.objectContaining({ confirmationSource: expected }) })
    );
    expect(createEvent.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ metadata: { source: expected } }));
  });
});

describe('mark order unreachable', () => {
  const orderId = new Types.ObjectId();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('flags the order for the helpdesk queue and records a note event with its author', async () => {
    const actorId = new Types.ObjectId();
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({ _id: orderId } as never);
    const createEvent = jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await OrderConfirmationService.markUnreachable(orderId.toString(), '  Messagerie, rappeler à 18h  ', actorId.toString());

    expect(update.mock.calls[0]?.[0]).toEqual({
      _id: orderId.toString(),
      customerConfirmationStatus: { $in: CONFIRMABLE_BY_ADMIN }
    });
    expect(update.mock.calls[0]?.[1]).toEqual({
      $set: {
        needsHelpdeskAttention: true,
        attentionReasonCode: AttentionReasonCode.UNREACHABLE,
        attentionReason: 'Messagerie, rappeler à 18h',
        attentionRequiredAt: expect.any(Date),
        lastNoteText: 'Messagerie, rappeler à 18h',
        lastNoteAt: expect.any(Date)
      }
    });
    expect(createEvent.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        type: OrderEventType.NOTE,
        note: 'Messagerie, rappeler à 18h',
        actorId,
        metadata: { attentionReasonCode: AttentionReasonCode.UNREACHABLE }
      })
    );
  });

  it.each([undefined, '', '   '])('falls back to a default note when the note is %p', async note => {
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({ _id: orderId } as never);
    const createEvent = jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await OrderConfirmationService.markUnreachable(orderId.toString(), note);

    expect(update.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ $set: expect.objectContaining({ attentionReason: 'Client injoignable' }) })
    );
    expect(createEvent.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ note: 'Client injoignable' }));
  });

  it('rejects a note longer than the note limit before touching the order', async () => {
    const update = jest.spyOn(Order, 'findOneAndUpdate');

    await expect(
      OrderConfirmationService.markUnreachable(orderId.toString(), 'a'.repeat(MAX_NOTE_LENGTH + 1))
    ).rejects.toMatchObject({ code: 'NoteTextTooLong', status: 400 });
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    [{ _id: orderId }, 'OrderUnreachableNotAllowed', 409],
    [null, 'OrderNotFound', 404]
  ])('rejects an order that is not awaiting confirmation (exists: %p)', async (exists, code, status) => {
    jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue(null as never);
    jest.spyOn(Order, 'exists').mockResolvedValue(exists as never);
    const createEvent = jest.spyOn(OrderEvent, 'create');

    await expect(OrderConfirmationService.markUnreachable(orderId.toString())).rejects.toMatchObject({ code, status });
    expect(createEvent).not.toHaveBeenCalled();
  });
});
