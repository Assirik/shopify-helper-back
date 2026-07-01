import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Order } from '../../models/Order';
import { ReconciliationService } from './reconciliation.service';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('reconciliation service', () => {
  it('aggregates delivered orders into a cash ledger (couriers) and a payables ledger (carriers)', async () => {
    // 1er appel = ledger caisse (par livreur) ; 2e appel = ledger transporteurs.
    jest
      .spyOn(Order, 'aggregate')
      .mockResolvedValueOnce([
        {
          _id: { toString: () => 'courier-1' },
          courierName: 'Moussa',
          deliveredOrders: 2,
          totalCollected: 50000,
          totalCourierFees: 3000,
          totalCarrierFees: 2000,
          totalNetRemitted: 45000,
          discrepancies: [{ orderName: '#1' }]
        }
      ] as never)
      .mockResolvedValueOnce([
        {
          _id: { toString: () => 'carrier-1' },
          carrierName: 'Dakar Dem Dikk',
          deliveredOrders: 1,
          totalDue: 2000
        }
      ] as never);

    await expect(ReconciliationService.summarize({ date: '2026-06-29' })).resolves.toEqual({
      date: '2026-06-29',
      totals: {
        deliveredOrders: 2,
        totalCollected: 50000,
        totalCourierFees: 3000,
        totalCarrierFees: 2000,
        totalNetRemitted: 45000,
        discrepancyCount: 1
      },
      couriers: [
        {
          courierId: 'courier-1',
          courierName: 'Moussa',
          deliveredOrders: 2,
          totalCollected: 50000,
          totalCourierFees: 3000,
          totalCarrierFees: 2000,
          totalNetRemitted: 45000,
          discrepancies: [{ orderName: '#1' }]
        }
      ],
      carriers: [
        {
          carrierId: 'carrier-1',
          carrierName: 'Dakar Dem Dikk',
          deliveredOrders: 1,
          totalDue: 2000
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
