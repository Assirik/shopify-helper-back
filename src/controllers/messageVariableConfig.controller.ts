import { Request, Response } from 'express';
import { MessageVariableConfigService } from '../utilities/services/messageVariableConfig.service';
import log from '../utilities/logger/logger';

export class MessageVariableConfigController {
  public static async get(_req: Request, res: Response) {
    const config = await MessageVariableConfigService.getConfig();

    return res.status(200).json({ data: config });
  }

  public static async update(req: Request, res: Response) {
    const result = await MessageVariableConfigService.updateConfig(req.body, req.userId || '');

    if ('errors' in result) {
      return res.status(400).json({ error: 'InvalidMessageVariableConfig', details: result.errors });
    }

    log.info({ configId: result.config._id, updatedBy: req.userId }, 'Updated message variable configuration');

    return res.status(200).json({ data: result.config });
  }
}
