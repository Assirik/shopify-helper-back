import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Message, MessageChannel, MessageStatus } from '../models/Message';
import { CustomerConfirmationStatus, Order } from '../models/Order';
import { notificationQueue } from '../queues/notification.queue';
import { computeDashboardStats, computeMongoDashboardStats } from './dashboard.controller';

jest.mock('../queues/notification.queue', () => ({
  notificationQueue: {
    getJobCounts: jest.fn()
  }
}));

afterEach(() => {
  jest.restoreAllMocks();
});

const mockBaseMongoStats = () => {
  jest.spyOn(Order, 'countDocuments')
    .mockResolvedValueOnce(1 as never) // ordersToday
    .mockResolvedValueOnce(2 as never) // ordersYesterday
    .mockResolvedValueOnce(3 as never) // attention
    .mockResolvedValueOnce(4 as never) // cancelledOrders
    .mockResolvedValueOnce(10 as never) // toDeliver
    .mockResolvedValueOnce(5 as never) // inDelivery
    .mockResolvedValueOnce(8 as never) // deliveredToday
    .mockResolvedValueOnce(2 as never); // cashDiscrepancies
  jest.spyOn(Order, 'aggregate')
    .mockResolvedValueOnce([{ _id: CustomerConfirmationStatus.CONFIRMED, count: 1 }] as never)
    .mockResolvedValueOnce([{ _id: null, cashCollected: 120000, netToRemit: 90000 }] as never);
  jest.spyOn(Message, 'countDocuments')
    .mockResolvedValueOnce(5 as never)
    .mockResolvedValueOnce(6 as never);
};

const OPERATIONAL_BASE = {
  toDeliver: 10,
  inDelivery: 5,
  deliveredToday: 8,
  cashCollectedToday: 120000,
  netToRemitToday: 90000,
  cashDiscrepancies: 2
};

describe('dashboard Mongo metrics', () => {
  it('computes order, message and confirmation metrics', async () => {
    const orderCount = jest.spyOn(Order, 'countDocuments')
      .mockResolvedValueOnce(3 as never) // ordersToday
      .mockResolvedValueOnce(2 as never) // ordersYesterday
      .mockResolvedValueOnce(4 as never) // attention
      .mockResolvedValueOnce(1 as never) // cancelledOrders
      .mockResolvedValueOnce(10 as never) // toDeliver
      .mockResolvedValueOnce(5 as never) // inDelivery
      .mockResolvedValueOnce(8 as never) // deliveredToday
      .mockResolvedValueOnce(2 as never); // cashDiscrepancies
    const aggregate = jest.spyOn(Order, 'aggregate')
      .mockResolvedValueOnce([
        { _id: CustomerConfirmationStatus.CONFIRMED, count: 7 },
        { _id: CustomerConfirmationStatus.PENDING, count: 2 },
        { _id: CustomerConfirmationStatus.NEEDS_ATTENTION, count: 1 },
        { _id: CustomerConfirmationStatus.EXPIRED, count: 0 },
        { _id: CustomerConfirmationStatus.SMS_ONLY, count: 0 },
        { _id: CustomerConfirmationStatus.CANCELLED, count: 20 }
      ] as never)
      .mockResolvedValueOnce([{ _id: null, cashCollected: 120000, netToRemit: 90000 }] as never);
    const messageCount = jest.spyOn(Message, 'countDocuments')
      .mockResolvedValueOnce(5 as never)
      .mockResolvedValueOnce(6 as never);

    await expect(computeMongoDashboardStats(new Date('2026-06-23T16:00:00.000Z'))).resolves.toEqual({
      ordersToday: 3,
      ordersYesterday: 2,
      attention: 4,
      confirmationRate: 70,
      messageFailures: 5,
      smsFallbacks: 6,
      cancelledOrders: 1,
      ...OPERATIONAL_BASE
    });

    expect(orderCount.mock.calls[0]?.[0] as unknown).toEqual({
      createdAt: { $gte: new Date('2026-06-23T00:00:00.000Z'), $lt: new Date('2026-06-24T00:00:00.000Z') }
    });
    expect(orderCount.mock.calls[1]?.[0] as unknown).toEqual({
      createdAt: { $gte: new Date('2026-06-22T00:00:00.000Z'), $lt: new Date('2026-06-23T00:00:00.000Z') }
    });
    expect(orderCount.mock.calls[2]?.[0] as unknown).toEqual({ needsHelpdeskAttention: true });
    expect(orderCount.mock.calls[3]?.[0] as unknown).toEqual({
      customerConfirmationStatus: CustomerConfirmationStatus.CANCELLED
    });
    expect(orderCount.mock.calls[6]?.[0] as unknown).toEqual({
      operationalStatus: 'delivered',
      deliveredAt: { $gte: new Date('2026-06-23T00:00:00.000Z'), $lt: new Date('2026-06-24T00:00:00.000Z') }
    });
    expect(aggregate).toHaveBeenNthCalledWith(1, [
      { $group: { _id: '$customerConfirmationStatus', count: { $sum: 1 } } }
    ]);
    expect(messageCount.mock.calls[0]?.[0] as unknown).toEqual({ status: MessageStatus.FAILED });
    expect(messageCount.mock.calls[1]?.[0] as unknown).toEqual({
      channel: MessageChannel.SMS,
      fallbackOfMessageId: { $ne: null }
    });
  });

  it('returns zero confirmationRate when the denominator is zero', async () => {
    jest.spyOn(Order, 'countDocuments')
      .mockResolvedValueOnce(0 as never) // ordersToday
      .mockResolvedValueOnce(0 as never) // ordersYesterday
      .mockResolvedValueOnce(0 as never) // attention
      .mockResolvedValueOnce(3 as never) // cancelledOrders
      .mockResolvedValueOnce(0 as never) // toDeliver
      .mockResolvedValueOnce(0 as never) // inDelivery
      .mockResolvedValueOnce(0 as never) // deliveredToday
      .mockResolvedValueOnce(0 as never); // cashDiscrepancies
    jest.spyOn(Order, 'aggregate')
      .mockResolvedValueOnce([{ _id: CustomerConfirmationStatus.CANCELLED, count: 3 }] as never)
      .mockResolvedValueOnce([] as never); // aucune commande livrée → pas de ligne caisse
    jest.spyOn(Message, 'countDocuments')
      .mockResolvedValueOnce(0 as never)
      .mockResolvedValueOnce(0 as never);

    await expect(computeMongoDashboardStats(new Date('2026-06-23T16:00:00.000Z'))).resolves.toEqual({
      ordersToday: 0,
      ordersYesterday: 0,
      attention: 0,
      confirmationRate: 0,
      messageFailures: 0,
      smsFallbacks: 0,
      cancelledOrders: 3,
      toDeliver: 0,
      inDelivery: 0,
      deliveredToday: 0,
      cashCollectedToday: 0,
      netToRemitToday: 0,
      cashDiscrepancies: 0
    });
  });
});

describe('dashboard queue health', () => {
  it('adds BullMQ completed and failed job counts when available', async () => {
    mockBaseMongoStats();
    jest.mocked(notificationQueue.getJobCounts).mockResolvedValueOnce({
      completed: 8,
      failed: 9
    } as never);

    await expect(computeDashboardStats(new Date('2026-06-23T16:00:00.000Z'))).resolves.toEqual({
      ordersToday: 1,
      ordersYesterday: 2,
      attention: 3,
      confirmationRate: 100,
      messageFailures: 5,
      smsFallbacks: 6,
      cancelledOrders: 4,
      ...OPERATIONAL_BASE,
      jobsSucceeded: 8,
      jobsFailed: 9
    });
  });

  it('omits BullMQ job counts when queue health is unavailable', async () => {
    mockBaseMongoStats();
    jest.mocked(notificationQueue.getJobCounts).mockRejectedValueOnce(new Error('Redis unavailable') as never);

    await expect(computeDashboardStats(new Date('2026-06-23T16:00:00.000Z'))).resolves.toEqual({
      ordersToday: 1,
      ordersYesterday: 2,
      attention: 3,
      confirmationRate: 100,
      messageFailures: 5,
      smsFallbacks: 6,
      cancelledOrders: 4,
      ...OPERATIONAL_BASE
    });
  });
});
