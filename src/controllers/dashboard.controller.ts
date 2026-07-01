import { Request, Response } from 'express';
import { Message, MessageChannel, MessageStatus } from '../models/Message';
import {
  CodPaymentStatus,
  CustomerConfirmationStatus,
  Order,
  OrderOperationalStatus
} from '../models/Order';
import { notificationQueue } from '../queues/notification.queue';
import log from '../utilities/logger/logger';

export interface DashboardStats {
  ordersToday: number;
  ordersYesterday: number;
  attention: number;
  confirmationRate: number;
  messageFailures: number;
  smsFallbacks: number;
  cancelledOrders: number;
  // Flux opérationnel de livraison (états courants, non bornés dans le temps).
  toDeliver: number;
  inDelivery: number;
  // Bornés au jour courant (deliveredAt).
  deliveredToday: number;
  // Caisse COD du jour (commandes livrées aujourd'hui).
  cashCollectedToday: number;
  netToRemitToday: number;
  cashDiscrepancies: number;
  jobsSucceeded?: number;
  jobsFailed?: number;
}

const startOfDay = (date: Date) => {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
};

const nextDay = (date: Date) => {
  const result = new Date(date);
  result.setDate(result.getDate() + 1);
  return result;
};

const roundToOneDecimal = (value: number) => {
  return Math.round(value * 10) / 10;
};

export const computeMongoDashboardStats = async (now = new Date()): Promise<DashboardStats> => {
  const todayStart = startOfDay(now);
  const tomorrowStart = nextDay(todayStart);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);

  const deliveredTodayMatch = {
    operationalStatus: OrderOperationalStatus.DELIVERED,
    deliveredAt: { $gte: todayStart, $lt: tomorrowStart }
  };

  const [
    ordersToday,
    ordersYesterday,
    attention,
    confirmationCounts,
    messageFailures,
    smsFallbacks,
    cancelledOrders,
    toDeliver,
    inDelivery,
    deliveredToday,
    cashDiscrepancies,
    cashRows
  ] = await Promise.all([
    Order.countDocuments({ createdAt: { $gte: todayStart, $lt: tomorrowStart } }),
    Order.countDocuments({ createdAt: { $gte: yesterdayStart, $lt: todayStart } }),
    Order.countDocuments({ needsHelpdeskAttention: true }),
    Order.aggregate<{ _id: CustomerConfirmationStatus; count: number }>([
      { $group: { _id: '$customerConfirmationStatus', count: { $sum: 1 } } }
    ]),
    Message.countDocuments({ status: MessageStatus.FAILED }),
    Message.countDocuments({ channel: MessageChannel.SMS, fallbackOfMessageId: { $ne: null } }),
    Order.countDocuments({ customerConfirmationStatus: CustomerConfirmationStatus.CANCELLED }),
    // À expédier : en attente de dispatch (inclut les échecs re-livrables).
    Order.countDocuments({
      operationalStatus: { $in: [OrderOperationalStatus.TO_DELIVER, OrderOperationalStatus.DELIVERY_FAILED] }
    }),
    Order.countDocuments({ operationalStatus: OrderOperationalStatus.IN_DELIVERY }),
    Order.countDocuments(deliveredTodayMatch),
    // Écart de caisse : livrée aujourd'hui mais encaissement non complet.
    Order.countDocuments({ ...deliveredTodayMatch, codPaymentStatus: { $ne: CodPaymentStatus.PAID } }),
    // Caisse du jour : encaissé et net à reverser, cohérents avec le rapprochement.
    Order.aggregate<{ _id: null; cashCollected: number; netToRemit: number }>([
      { $match: deliveredTodayMatch },
      {
        $group: {
          _id: null,
          cashCollected: { $sum: { $ifNull: ['$codCollectedAmount', 0] } },
          netToRemit: { $sum: { $ifNull: ['$codNetRemitted', 0] } }
        }
      }
    ])
  ]);

  const countByStatus = confirmationCounts.reduce((map, item) => {
    map[item._id] = item.count;
    return map;
  }, {} as Partial<Record<CustomerConfirmationStatus, number>>);
  const confirmed = countByStatus[CustomerConfirmationStatus.CONFIRMED] || 0;
  const denominator =
    confirmed +
    (countByStatus[CustomerConfirmationStatus.PENDING] || 0) +
    (countByStatus[CustomerConfirmationStatus.NEEDS_ATTENTION] || 0) +
    (countByStatus[CustomerConfirmationStatus.EXPIRED] || 0) +
    (countByStatus[CustomerConfirmationStatus.SMS_ONLY] || 0);

  const cash = cashRows[0];

  return {
    ordersToday,
    ordersYesterday,
    attention,
    confirmationRate: denominator === 0 ? 0 : roundToOneDecimal((confirmed / denominator) * 100),
    messageFailures,
    smsFallbacks,
    cancelledOrders,
    toDeliver,
    inDelivery,
    deliveredToday,
    cashCollectedToday: cash?.cashCollected || 0,
    netToRemitToday: cash?.netToRemit || 0,
    cashDiscrepancies
  };
};

export const computeDashboardStats = async (now = new Date()): Promise<DashboardStats> => {
  const stats = await computeMongoDashboardStats(now);

  try {
    const jobCounts = await notificationQueue.getJobCounts();

    return {
      ...stats,
      jobsSucceeded: jobCounts.completed || 0,
      jobsFailed: jobCounts.failed || 0
    };
  } catch (err) {
    log.warn({ err }, 'Dashboard queue health unavailable');
    return stats;
  }
};

export class DashboardController {
  public static async stats(_req: Request, res: Response) {
    const stats = await computeDashboardStats();

    log.info(stats, 'Fetched dashboard stats');

    return res.status(200).json({
      data: stats
    });
  }
}
