import { Request, Response } from 'express';
import { ProviderError } from '../providers/messaging.provider';
import { MetaWhatsAppProvider } from '../providers/metaWhatsApp.provider';
import log from '../utilities/logger/logger';

const metaWhatsAppProvider = new MetaWhatsAppProvider();

export class WhatsAppTemplateController {
  public static async list(req: Request, res: Response) {
    const limit = Number(req.query.limit) || undefined;
    const after = typeof req.query.after === 'string' ? req.query.after : undefined;

    try {
      const data = await metaWhatsAppProvider.fetchMessageTemplates({ limit, after });

      log.info({ limit, hasCursor: Boolean(after) }, 'Fetched WhatsApp message templates from Meta');

      return res.status(200).json({ data });
    } catch (err) {
      if (err instanceof ProviderError) {
        const status = err.code === 'PROVIDER_NOT_CONFIGURED' ? 500 : 502;
        return res.status(status).json({ error: err.code, message: err.message });
      }

      throw err;
    }
  }
}
