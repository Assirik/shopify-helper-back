import crypto from 'crypto';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import config from '../utilities/config/env.config';

const META_SIGNATURE_HEADER = 'X-Hub-Signature-256';

export const createMetaSignature = (rawBody: Buffer | string, appSecret: string): string => {
  return `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
};

const isValidSignature = (receivedSignature: string, expectedSignature: string): boolean => {
  const received = Buffer.from(receivedSignature, 'utf8');
  const expected = Buffer.from(expectedSignature, 'utf8');

  if (received.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(received, expected);
};

export const verifyWhatsAppWebhookWithSecret = (appSecret: string): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!appSecret) {
      return res.status(500).json({ error: 'WhatsAppAppSecretMissing' });
    }

    const receivedSignature = req.get(META_SIGNATURE_HEADER);

    if (!receivedSignature) {
      return res.status(401).json({ error: 'MissingWhatsAppSignature' });
    }

    if (!req.rawBody) {
      return res.status(400).json({ error: 'RawBodyUnavailable' });
    }

    const expectedSignature = createMetaSignature(req.rawBody, appSecret);

    if (!isValidSignature(receivedSignature, expectedSignature)) {
      return res.status(401).json({ error: 'InvalidWhatsAppSignature' });
    }

    return next();
  };
};

export const verifyWhatsAppWebhook = verifyWhatsAppWebhookWithSecret(config.metaWhatsApp.appSecret);
