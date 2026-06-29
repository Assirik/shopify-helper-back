import { Types } from 'mongoose';
import { CodPaymentStatus, Order, OrderOperationalStatus } from '../../models/Order';

export interface ReconciliationQuery {
  date?: string;
  courierId?: string;
}

const parseDateRange = (date?: string) => {
  const rawDate = date?.trim();
  const base = rawDate ? new Date(`${rawDate}T00:00:00.000Z`) : new Date();

  if (Number.isNaN(base.getTime())) {
    return undefined;
  }

  const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  return { start, end };
};

export class ReconciliationError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'ReconciliationError';
    this.code = code;
    this.status = status;
  }
}

export class ReconciliationService {
  public static async summarize(query: ReconciliationQuery) {
    const range = parseDateRange(query.date);

    if (!range) {
      throw new ReconciliationError('InvalidReconciliationDate', 'Invalid reconciliation date', 400);
    }

    const match: Record<string, unknown> = {
      operationalStatus: OrderOperationalStatus.DELIVERED,
      deliveredAt: { $gte: range.start, $lt: range.end }
    };

    if (query.courierId) {
      if (!Types.ObjectId.isValid(query.courierId)) {
        throw new ReconciliationError('CourierNotFound', 'Courier not found', 404);
      }
      match.assignedCourierId = new Types.ObjectId(query.courierId);
    }

    // Ledger CAISSE : groupé par livreur interne qui détient le cash encaissé.
    // Le net dû en caisse = encaissé − rémunération livreur − coût transporteur (déjà
    // défalqués et stockés dans codNetRemitted par le service de livraison).
    const courierRows = await Order.aggregate([
      { $match: match },
      {
        $lookup: {
          from: 'couriers',
          localField: 'assignedCourierId',
          foreignField: '_id',
          as: 'courier'
        }
      },
      { $unwind: { path: '$courier', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: '$assignedCourierId',
          courierName: { $first: '$courier.name' },
          deliveredOrders: { $sum: 1 },
          totalCollected: { $sum: { $ifNull: ['$codCollectedAmount', 0] } },
          totalCourierFees: { $sum: { $ifNull: ['$courierFeeAmount', 0] } },
          totalCarrierFees: { $sum: { $ifNull: ['$carrierFeeAmount', 0] } },
          totalNetRemitted: { $sum: { $ifNull: ['$codNetRemitted', 0] } },
          discrepancies: {
            $push: {
              $cond: [
                { $ne: ['$codPaymentStatus', CodPaymentStatus.PAID] },
                {
                  orderId: '$_id',
                  orderName: '$shopifyOrderName',
                  codPaymentStatus: '$codPaymentStatus',
                  expectedAmount: '$codExpectedAmount',
                  collectedAmount: '$codCollectedAmount',
                  netRemitted: '$codNetRemitted'
                },
                '$$REMOVE'
              ]
            }
          }
        }
      },
      { $sort: { courierName: 1 } }
    ]);

    // Ledger TRANSPORTEURS : montant dû à chaque transporteur tiers (ce qu'on doit payer).
    const carrierRows = await Order.aggregate([
      { $match: { ...match, assignedCarrierId: { $ne: null } } },
      {
        $lookup: {
          from: 'carriers',
          localField: 'assignedCarrierId',
          foreignField: '_id',
          as: 'carrier'
        }
      },
      { $unwind: { path: '$carrier', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: '$assignedCarrierId',
          carrierName: { $first: '$carrier.name' },
          deliveredOrders: { $sum: 1 },
          totalDue: { $sum: { $ifNull: ['$carrierFeeAmount', 0] } }
        }
      },
      { $sort: { carrierName: 1 } }
    ]);

    const couriers = courierRows.map(row => ({
      courierId: row._id?.toString(),
      courierName: row.courierName || 'Livreur non assigné',
      deliveredOrders: row.deliveredOrders,
      totalCollected: row.totalCollected,
      totalCourierFees: row.totalCourierFees,
      totalCarrierFees: row.totalCarrierFees,
      totalNetRemitted: row.totalNetRemitted,
      discrepancies: row.discrepancies || []
    }));

    const carriers = carrierRows.map(row => ({
      carrierId: row._id?.toString(),
      carrierName: row.carrierName || 'Transporteur inconnu',
      deliveredOrders: row.deliveredOrders,
      totalDue: row.totalDue
    }));

    return {
      date: range.start.toISOString().slice(0, 10),
      // Totaux calculés sur le ledger caisse, qui couvre toutes les commandes livrées une fois.
      totals: couriers.reduce(
        (sum, group) => ({
          deliveredOrders: sum.deliveredOrders + group.deliveredOrders,
          totalCollected: sum.totalCollected + group.totalCollected,
          totalCourierFees: sum.totalCourierFees + group.totalCourierFees,
          totalCarrierFees: sum.totalCarrierFees + group.totalCarrierFees,
          totalNetRemitted: sum.totalNetRemitted + group.totalNetRemitted,
          discrepancyCount: sum.discrepancyCount + group.discrepancies.length
        }),
        {
          deliveredOrders: 0,
          totalCollected: 0,
          totalCourierFees: 0,
          totalCarrierFees: 0,
          totalNetRemitted: 0,
          discrepancyCount: 0
        }
      ),
      couriers,
      carriers
    };
  }
}
