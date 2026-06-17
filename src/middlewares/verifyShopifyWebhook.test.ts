import { describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { IncomingMessage, ServerResponse } from 'http';
import { createShopifyHmac, verifyShopifyWebhookWithSecret } from './verifyShopifyWebhook';

const webhookSecret = 'test-shopify-webhook-secret';

const createTestApp = () => {
  const app = express();

  app.use(
    express.json({
      verify: (req: IncomingMessage, _res: ServerResponse, buffer: Buffer) => {
        (req as express.Request).rawBody = Buffer.from(buffer);
      }
    })
  );

  app.post('/webhook', verifyShopifyWebhookWithSecret(webhookSecret), (_req, res) => {
    res.status(202).json({ accepted: true });
  });

  return app;
};

describe('verifyShopifyWebhookWithSecret', () => {
  it('accepts requests with a valid Shopify HMAC signature', async () => {
    const app = createTestApp();
    const rawPayload = JSON.stringify({ id: 123, name: '#1001' });
    const hmac = createShopifyHmac(rawPayload, webhookSecret);

    const response = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Hmac-Sha256', hmac)
      .send(rawPayload);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ accepted: true });
  });

  it('rejects requests without a Shopify HMAC signature', async () => {
    const app = createTestApp();

    const response = await request(app).post('/webhook').send({ id: 123 });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'MissingShopifyHmac' });
  });

  it('rejects requests with an invalid Shopify HMAC signature', async () => {
    const app = createTestApp();

    const response = await request(app)
      .post('/webhook')
      .set('X-Shopify-Hmac-Sha256', 'invalid-signature')
      .send({ id: 123 });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'InvalidShopifyHmac' });
  });

  it('fails closed when the webhook secret is missing', async () => {
    const app = express();

    app.use(
      express.json({
        verify: (req: IncomingMessage, _res: ServerResponse, buffer: Buffer) => {
          (req as express.Request).rawBody = Buffer.from(buffer);
        }
      })
    );
    app.post('/webhook', verifyShopifyWebhookWithSecret(''), (_req, res) => {
      res.status(202).json({ accepted: true });
    });

    const response = await request(app)
      .post('/webhook')
      .set('X-Shopify-Hmac-Sha256', 'anything')
      .send({ id: 123 });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'ShopifyWebhookSecretMissing' });
  });
});
