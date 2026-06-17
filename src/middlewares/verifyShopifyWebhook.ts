import crypto from 'crypto';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import config from '../utilities/config/env.config';

const SHOPIFY_HMAC_HEADER = 'X-Shopify-Hmac-Sha256';

export const createShopifyHmac = (rawBody: Buffer | string, webhookSecret: string): string => {
  return crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('base64');
};

const isValidHmac = (receivedHmac: string, expectedHmac: string): boolean => {
  const received = Buffer.from(receivedHmac, 'utf8');
  const expected = Buffer.from(expectedHmac, 'utf8');

  if (received.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(received, expected);
};

export const verifyShopifyWebhookWithSecret = (webhookSecret: string): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!webhookSecret) {
      return res.status(500).json({ error: 'ShopifyWebhookSecretMissing' });
    }

    const receivedHmac = req.get(SHOPIFY_HMAC_HEADER);

    if (!receivedHmac) {
      return res.status(401).json({ error: 'MissingShopifyHmac' });
    }

    if (!req.rawBody) {
      return res.status(400).json({ error: 'RawBodyUnavailable' });
    }

    const expectedHmac = createShopifyHmac(req.rawBody, webhookSecret);

    if (!isValidHmac(receivedHmac, expectedHmac)) {
      return res.status(401).json({ error: 'InvalidShopifyHmac' });
    }

    return next();
  };
};

export const verifyShopifyWebhook = verifyShopifyWebhookWithSecret(config.shopify.webhookSecret);
