import { Request, Response } from 'express';
import log from '../utilities/logger/logger';

export interface DashboardStats {
  ordersToday: number;
  ordersYesterday: number;
  attention: number;
  confirmationRate: number;
  messageFailures: number;
  smsFallbacks: number;
  cancelledOrders: number;
  jobsSucceeded?: number;
  jobsFailed?: number;
}

export class DashboardController {
  public static async stats(_req: Request, res: Response) {
    const stats: DashboardStats = {
      ordersToday: 0,
      ordersYesterday: 0,
      attention: 0,
      confirmationRate: 0,
      messageFailures: 0,
      smsFallbacks: 0,
      cancelledOrders: 0
    };

    log.info(stats, 'Fetched dashboard stats');

    return res.status(200).json({
      data: stats
    });
  }
}
