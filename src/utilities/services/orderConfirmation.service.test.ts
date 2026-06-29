import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { CustomerConfirmationStatus, Order, OrderOperationalStatus } from '../../models/Order';
import config from '../config/env.config';
import { getOrderActionCapabilities } from './orderCapabilities.service';
import { OrderConfirmationService } from './orderConfirmation.service';

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
      canReturn: false
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
      canReturn: false
    });
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
