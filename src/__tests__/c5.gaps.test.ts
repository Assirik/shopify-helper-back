import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import config from '../utilities/config/env.config';
import { Message } from '../models/Message';
import {
  ConfirmationSource,
  CustomerConfirmationStatus,
  IOrder,
  Order,
  OrderOperationalStatus,
  ReminderSource
} from '../models/Order';
import { buildPurchasePayload } from '../providers/metaCapi.provider';
import { enqueueConfirmationReminder } from '../queues/notification.queue';

jest.mock('../queues/notification.queue', () => ({
  enqueueConfirmationReminder: jest.fn(),
  enqueueOrderCancelled: jest.fn(),
  enqueueOrderConfirmed: jest.fn()
}));

jest.mock('../utilities/services/capiPurchase.service', () => ({
  triggerCapiPurchase: jest.fn(async () => undefined)
}));

jest.mock('../utilities/logger/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

import { OrderConfirmationService } from '../utilities/services/orderConfirmation.service';

// Gaps left by the per-task tests of the Chantier 5 (see the coverage map of task T11).

const HOUR = 60 * 60 * 1000;
const orderId = new Types.ObjectId();

describe('Meta Purchase payload: never an invented user agent (C5.3)', () => {
  const baseOrder = (overrides: Record<string, unknown> = {}) =>
    ({
      shopifyOrderId: '1234567890',
      customerId: new Types.ObjectId(),
      customerName: 'Aïssatou Diallo',
      customerPhoneE164: '+221776986780',
      subtotalPrice: '14000',
      lineItems: [{ variantId: 'v-1', quantity: 2, price: '5000' }],
      confirmedAt: new Date('2026-10-29T10:00:00.000Z'),
      createdAt: new Date('2026-10-28T08:00:00.000Z'),
      ...overrides
    }) as unknown as IOrder;

  it.each([
    ['chat', { confirmationSource: ConfirmationSource.WHATSAPP_BUTTON }],
    ['phone_call', { confirmationSource: ConfirmationSource.PHONE_CALL }],
    ['phone_call', { confirmationSource: ConfirmationSource.ADMIN }],
    ['phone_call', { confirmationSource: undefined, confirmedAt: undefined, deliveredAt: new Date('2026-10-30T10:00:00.000Z') }]
  ])('sends %s without client_user_agent when none was captured (%j)', (actionSource, overrides) => {
    const { payload } = buildPurchasePayload(baseOrder(overrides));

    expect(payload.action_source).toBe(actionSource);
    expect(payload.user_data).not.toHaveProperty('client_user_agent');
    expect(JSON.stringify(payload)).not.toContain('client_user_agent');
  });

  it('keeps the captured user agent, unhashed, and website whatever the confirmation source', () => {
    const { payload } = buildPurchasePayload(
      baseOrder({ confirmationSource: ConfirmationSource.WHATSAPP_BUTTON, capiClientUserAgent: 'Mozilla/5.0 (Gap)' })
    );

    expect(payload.action_source).toBe('website');
    expect(payload.user_data.client_user_agent).toBe('Mozilla/5.0 (Gap)');
  });
});

describe('automatic reminders keep their 24 h / 48 h / 72 h schedule next to the T+5 request (C5.6a)', () => {
  const NOW = new Date('2026-10-31T12:00:00.000Z').getTime();
  const originalConfirmation = { ...config.confirmation };

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    Object.assign(config.confirmation, originalConfirmation);
    jest.restoreAllMocks();
  });

  it('reminds at 24 h (first) and 48 h (second), expires after the reminders at 72 h, and never uses the T+5 delay', async () => {
    const find = jest.spyOn(Order, 'find').mockReturnValue({
      select: () => ({ limit: () => Promise.resolve([]) })
    } as never);
    const updateMany = jest.spyOn(Order, 'updateMany').mockResolvedValue({ modifiedCount: 0 } as never);

    await OrderConfirmationService.runConfirmationMaintenance();

    expect(config.confirmation.firstReminderHours).toBe(24);
    expect(config.confirmation.secondReminderHours).toBe(48);
    expect(config.confirmation.expireHours).toBe(72);
    expect(config.confirmation.maxReminders).toBe(2);

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0]?.[0]).toEqual({
      customerConfirmationStatus: CustomerConfirmationStatus.PENDING,
      reminderCount: { $gte: 2 },
      createdAt: { $lte: new Date(NOW - 72 * HOUR) }
    });

    const filters = find.mock.calls.map(call => call[0] as unknown as Record<string, unknown>);
    // Second reminder first, then the first one.
    expect(filters.map(filter => filter.reminderCount)).toEqual([1, 0]);
    expect(filters[0]?.createdAt).toEqual({ $lte: new Date(NOW - 48 * HOUR) });
    expect(filters[1]?.createdAt).toEqual({ $lte: new Date(NOW - 24 * HOUR) });
    // Strict equality: any extra condition (e.g. on notificationStatus) would silently exclude
    // orders whose T+5 request was sent, which must still get their reminders.
    const eligible = (reminderCount: number, hours: number) => ({
      customerConfirmationStatus: CustomerConfirmationStatus.PENDING,
      reminderCount,
      createdAt: { $lte: new Date(NOW - hours * HOUR) },
      customerPhoneE164: { $exists: true, $nin: [null, ''] },
      shopifyCancelledAt: null,
      operationalStatus: { $nin: [OrderOperationalStatus.DELIVERED, OrderOperationalStatus.RETURNED] }
    });
    expect(filters).toEqual([eligible(1, 48), eligible(0, 24)]);
    // The T+5 request is a separate delay, never shorter than 5 minutes, unrelated to the reminders.
    expect(config.confirmation.initialRequestDelayMinutes).toBeGreaterThanOrEqual(5);
  });

  it('claims each reminder with the strict conditional filter, whatever the T+5 request status', async () => {
    jest.spyOn(Order, 'updateMany').mockResolvedValue({ modifiedCount: 0 } as never);
    jest.spyOn(Order, 'find').mockReturnValue({
      select: () => ({ limit: () => Promise.resolve([{ _id: orderId }]) })
    } as never);
    const claim = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({ _id: orderId } as never);
    jest.spyOn(Message, 'create').mockResolvedValue({ _id: new Types.ObjectId() } as never);
    jest.mocked(enqueueConfirmationReminder).mockResolvedValue({ id: 'reminder-1' } as never);

    const result = await OrderConfirmationService.runConfirmationMaintenance();

    expect(result).toEqual({ expired: 0, firstReminders: 1, secondReminders: 1 });
    const claimFilter = (reminderCount: number) => ({
      _id: orderId,
      customerConfirmationStatus: CustomerConfirmationStatus.PENDING,
      reminderCount,
      shopifyCancelledAt: null,
      operationalStatus: { $nin: [OrderOperationalStatus.DELIVERED, OrderOperationalStatus.RETURNED] }
    });
    expect(claim.mock.calls.map(call => call[0])).toEqual([claimFilter(1), claimFilter(0)]);
    expect(claim.mock.calls[0]?.[1]).toEqual({
      $inc: { reminderCount: 1 },
      $set: { lastReminderAt: expect.any(Date), lastReminderSource: ReminderSource.AUTO }
    });
  });
});
