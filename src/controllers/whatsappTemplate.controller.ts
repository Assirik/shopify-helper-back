import { Request, Response } from 'express';
import { ProviderError } from '../providers/messaging.provider';
import { MetaWhatsAppProvider } from '../providers/metaWhatsApp.provider';
import log from '../utilities/logger/logger';

const metaWhatsAppProvider = new MetaWhatsAppProvider();
const MAX_TEMPLATE_LIMIT = 100;

export const parseTemplateLimit = (value: unknown): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_TEMPLATE_LIMIT ? parsed : undefined;
};

export class WhatsAppTemplateController {
  public static async list(req: Request, res: Response) {
    const limit = parseTemplateLimit(req.query.limit);
    const after = typeof req.query.after === 'string' ? req.query.after : undefined;

    if (req.query.limit !== undefined && limit === undefined) {
      return res.status(400).json({ error: 'InvalidTemplateLimit' });
    }

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
