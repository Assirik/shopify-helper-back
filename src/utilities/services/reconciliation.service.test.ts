import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Order } from '../../models/Order';
import { ReconciliationService } from './reconciliation.service';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('reconciliation service', () => {
  it('aggregates delivered orders by courier for a date', async () => {
    jest.spyOn(Order, 'aggregate').mockResolvedValue([
      {
        _id: { courierId: undefined, channel: 'carrier' },
        deliveredOrders: 1,
        totalCollected: 20000,
        totalCourierFees: 1500,
        totalNetRemitted: 18500,
        discrepancies: []
      },
      {
        _id: { courierId: { toString: () => 'courier-1' }, channel: 'internal' },
        courierName: 'Moussa',
        deliveredOrders: 2,
        totalCollected: 50000,
        totalCourierFees: 3000,
        totalNetRemitted: 47000,
        discrepancies: [{ orderName: '#1' }]
      }
    ] as never);

    await expect(ReconciliationService.summarize({ date: '2026-06-29' })).resolves.toEqual({
      date: '2026-06-29',
      totals: {
        deliveredOrders: 3,
        totalCollected: 70000,
        totalCourierFees: 3000,
        totalNetRemitted: 67000,
        discrepancyCount: 1
      },
      groups: [
        {
          courierId: undefined,
          courierName: 'Transporteur tiers',
          deliveryChannel: 'carrier',
          deliveredOrders: 1,
          totalCollected: 20000,
          totalCourierFees: 0,
          totalNetRemitted: 20000,
          discrepancies: []
        },
        {
          courierId: 'courier-1',
          courierName: 'Moussa',
          deliveryChannel: 'internal',
          deliveredOrders: 2,
          totalCollected: 50000,
          totalCourierFees: 3000,
          totalNetRemitted: 47000,
          discrepancies: [{ orderName: '#1' }]
        }
      ]
    });
  });

  it('rejects invalid dates', async () => {
    await expect(ReconciliationService.summarize({ date: 'not-a-date' })).rejects.toMatchObject({
      code: 'InvalidReconciliationDate',
      status: 400
    });
  });
});
