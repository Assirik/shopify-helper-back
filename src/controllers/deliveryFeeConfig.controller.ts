import { Request, Response } from 'express';
import { DeliveryFeeConfigService } from '../utilities/services/deliveryFeeConfig.service';
import log from '../utilities/logger/logger';

export class DeliveryFeeConfigController {
  public static async get(_req: Request, res: Response) {
    const config = await DeliveryFeeConfigService.getOrCreateConfig();

    return res.status(200).json({ data: config });
  }

  public static async update(req: Request, res: Response) {
    const result = await DeliveryFeeConfigService.updateConfig(req.body, req.userId || '');

    if ('errors' in result) {
      return res.status(400).json({ error: 'InvalidDeliveryFeeConfig', details: result.errors });
    }

    log.info({ configId: result.config._id, updatedBy: req.userId }, 'Updated delivery fee configuration');

    return res.status(200).json({ data: result.config });
  }
}
