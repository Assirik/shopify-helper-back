import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Request, Response } from 'express';
import { Types } from 'mongoose';

jest.mock('../queues/notification.queue', () => ({
  enqueueOrderConfirmation: jest.fn()
}));

import { BrowserSession } from '../models/BrowserSession';
import { Customer } from '../models/Customer';
import { Message } from '../models/Message';
import { Order } from '../models/Order';
import { WebhookEvent } from '../models/WebhookEvent';
import { enqueueOrderConfirmation } from '../queues/notification.queue';
import log from '../utilities/logger/logger';
import {
  ShopifyWebhookController,
  extractDeliverySnapshot,
  BROWSER_SESSION_LOOKUP_TIMEOUT_MS,
  BROWSER_SESSION_QUERY_MAX_TIME_MS,
  findBrowserSessionCapiFields,
  normalizeDeliveryMoment
} from './shopifyWebhook.controller';

describe('extractDeliverySnapshot', () => {
  it('extracts the immutable delivery snapshot observed in Shopify payload 6', () => {
    const snapshot = extractDeliverySnapshot({
      shipping_address: {
        province: null,
        address2: 'Cap Skiring',
        latitude: 12.5072598,
        longitude: -16.6630268
      },
      browser_ip: null,
      customer_locale: null,
      note_attributes: [
        { name: 'Région', value: 'Ziguinchor' },
        { name: 'Adresse de livraison', value: 'Cap Skiring' },
        { name: 'Moment de livraison préféré', value: 'Après Midi' },
        { name: 'IP Address', value: '154.124.16.8' }
      ]
    });

    expect(snapshot).toEqual({
      deliveryRegion: 'Ziguinchor',
      deliveryRegionCode: 'SN_ZG',
      deliveryPreferredMoment: 'Après Midi',
      deliveryAddress: 'Cap Skiring',
      deliveryLatitude: 12.5072598,
      deliveryLongitude: -16.6630268,
      browserIp: '154.124.16.8',
      customerLocale: undefined
    });
  });

  it('falls back to Shopify city and address1 when Easysell delivery fields are absent', () => {
    const snapshot = extractDeliverySnapshot({
      shipping_address: {
        province: null,
        city: 'Dakar',
        address1: 'Mbao',
        address2: null
      }
    });

    expect(snapshot).toEqual(
      expect.objectContaining({
        deliveryRegion: 'Dakar',
        deliveryRegionCode: 'SN_DK',
        deliveryAddress: 'Mbao'
      })
    );
  });
});

describe('normalizeDeliveryMoment', () => {
  it.each([
    ['Après Midi', 'apres midi'],
    ['Après-midi', 'apres midi'],
    ['APRÈS  MIDI', 'apres midi'],
    ['Matinée', 'matinee'],
    ['Soir (avant 20h)', 'soir (avant 20h)']
  ])('normalizes %p to %p (accent/case/hyphen tolerant)', (input, expected) => {
    expect(normalizeDeliveryMoment(input)).toBe(expected);
  });
});

const ORDER_CREATED_AT = new Date('2026-10-29T12:00:00.000Z');
const MINUTE = 60 * 1000;

const browserSession = (updatedAt: Date, overrides: Record<string, unknown> = {}) => ({
  phoneE164: '+221776986780',
  fbp: 'fb.1.1730000000000.111',
  fbc: 'fb.1.1730000000000.abc',
  fbclid: 'abc',
  userAgent: 'Mozilla/5.0 (Test)',
  pageUrl: 'https://shop.example.com/products/x',
  ip: '1.2.3.4',
  updatedAt,
  ...overrides
});

const mockBrowserSessionLookup = (result: unknown) => {
  const query = {
    maxTimeMS: jest.fn(() => query),
    lean: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result))
  };
  return jest.spyOn(BrowserSession, 'findOne').mockReturnValue(query as never);
};

// A lookup that never settles (driver stalled).
const mockHangingBrowserSessionLookup = () =>
  jest.spyOn(BrowserSession, 'findOne').mockReturnValue({
    maxTimeMS() {
      return this;
    },
    lean: () => new Promise(() => undefined)
  } as never);

const LINKED_FIELDS = {
  capiFbp: 'fb.1.1730000000000.111',
  capiFbc: 'fb.1.1730000000000.abc',
  capiClientUserAgent: 'Mozilla/5.0 (Test)',
  capiEventSourceUrl: 'https://shop.example.com/products/x'
};

describe('findBrowserSessionCapiFields', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('links the capture made a few minutes before the order', async () => {
    const findOne = mockBrowserSessionLookup(browserSession(new Date(ORDER_CREATED_AT.getTime() - 3 * MINUTE)));

    await expect(findBrowserSessionCapiFields('+221776986780', ORDER_CREATED_AT)).resolves.toEqual({
      linked: true,
      fields: LINKED_FIELDS
    });
    expect(findOne.mock.calls[0]?.[0]).toEqual({ phoneE164: '+221776986780' });
    const query = findOne.mock.results[0]?.value as { maxTimeMS: jest.Mock };
    expect(query.maxTimeMS).toHaveBeenCalledWith(BROWSER_SESSION_QUERY_MAX_TIME_MS);
  });

  it.each([
    ['30 min before', -30 * MINUTE],
    ['5 min after (clock skew)', 5 * MINUTE]
  ])('links a capture exactly %s', async (_label, offset) => {
    mockBrowserSessionLookup(browserSession(new Date(ORDER_CREATED_AT.getTime() + offset)));

    await expect(findBrowserSessionCapiFields('+221776986780', ORDER_CREATED_AT)).resolves.toEqual(
      expect.objectContaining({ linked: true })
    );
  });

  it('copies only the fields that were captured', async () => {
    mockBrowserSessionLookup(browserSession(ORDER_CREATED_AT, { fbp: undefined, fbc: undefined }));

    await expect(findBrowserSessionCapiFields('+221776986780', ORDER_CREATED_AT)).resolves.toEqual({
      linked: true,
      fields: {
        capiClientUserAgent: 'Mozilla/5.0 (Test)',
        capiEventSourceUrl: 'https://shop.example.com/products/x'
      }
    });
  });

  it('fills nothing when no capture exists', async () => {
    mockBrowserSessionLookup(null);

    await expect(findBrowserSessionCapiFields('+221776986780', ORDER_CREATED_AT)).resolves.toEqual({
      linked: false,
      fields: {}
    });
  });

  it.each([
    ['more than 30 min before the order', -31 * MINUTE],
    ['more than 5 min after the order', 6 * MINUTE]
  ])('fills nothing for a capture %s', async (_label, offset) => {
    mockBrowserSessionLookup(browserSession(new Date(ORDER_CREATED_AT.getTime() + offset)));

    await expect(findBrowserSessionCapiFields('+221776986780', ORDER_CREATED_AT)).resolves.toEqual({
      linked: false,
      fields: {}
    });
  });

  it('does not query without a normalized phone', async () => {
    const findOne = mockBrowserSessionLookup(null);

    await expect(findBrowserSessionCapiFields(undefined, ORDER_CREATED_AT)).resolves.toEqual({
      linked: false,
      fields: {}
    });
    expect(findOne).not.toHaveBeenCalled();
  });
});

describe('ShopifyWebhookController.ordersCreate — browser session link', () => {
  const orderId = new Types.ObjectId();
  const payload = {
    id: 9001,
    name: '#1201',
    created_at: ORDER_CREATED_AT.toISOString(),
    total_price: '15000',
    currency: 'XOF',
    phone: '77 698 67 80',
    line_items: []
  };

  let orderCreate: ReturnType<typeof jest.spyOn>;
  let orderFindOne: ReturnType<typeof jest.spyOn>;
  let logInfo: ReturnType<typeof jest.spyOn>;

  const callOrdersCreate = async () => {
    const headers: Record<string, string> = { 'x-shopify-webhook-id': `wh-${Math.random()}` };
    const req = {
      body: payload,
      rawBody: Buffer.from(JSON.stringify(payload)),
      get: (name: string) => headers[name.toLowerCase()]
    } as unknown as Request;
    const res = {
      statusCode: 0,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        this.body = body;
        return this;
      }
    };

    await ShopifyWebhookController.ordersCreate(req, res as unknown as Response);
    return res;
  };

  const linkLogLine = () =>
    (logInfo.mock.calls as unknown[][]).find(call => call[1] === 'Browser session link checked')?.[0] as Record<string, unknown> | undefined;

  beforeEach(() => {
    jest.spyOn(WebhookEvent, 'findOne').mockResolvedValue(null as never);
    jest
      .spyOn(WebhookEvent, 'create')
      .mockImplementation((async () => ({ _id: new Types.ObjectId(), status: 'processed' })) as never);
    orderFindOne = jest.spyOn(Order, 'findOne').mockResolvedValue(null as never);
    jest.spyOn(Customer, 'findOneAndUpdate').mockResolvedValue({
      _id: new Types.ObjectId(),
      save: jest.fn(async () => undefined)
    } as never);
    orderCreate = jest.spyOn(Order, 'create').mockImplementation((async (doc: Record<string, unknown>) => ({
      ...doc,
      _id: orderId,
      lineItems: []
    })) as never);
    jest.spyOn(Message, 'create').mockResolvedValue({ _id: new Types.ObjectId() } as never);
    (enqueueOrderConfirmation as jest.Mock).mockResolvedValue({ id: 'job-1', queueName: 'notifications' } as never);
    logInfo = jest.spyOn(log, 'info');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('copies the browser signals onto the new order and logs the link', async () => {
    mockBrowserSessionLookup(browserSession(new Date(ORDER_CREATED_AT.getTime() - 2 * MINUTE)));

    const res = await callOrdersCreate();

    expect(res.statusCode).toBe(202);
    expect(orderCreate.mock.calls[0]?.[0]).toEqual(expect.objectContaining(LINKED_FIELDS));
    expect(linkLogLine()).toEqual(expect.objectContaining({ browserSessionLinked: true, browserSessionLookupFailed: false }));
  });

  it('ingests the order unchanged when no capture exists', async () => {
    mockBrowserSessionLookup(null);

    const res = await callOrdersCreate();

    expect(res.statusCode).toBe(202);
    const created = orderCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(created.customerPhoneE164).toBe('+221776986780');
    for (const field of Object.keys(LINKED_FIELDS)) {
      expect(created).not.toHaveProperty(field);
    }
    expect(linkLogLine()).toEqual(expect.objectContaining({ browserSessionLinked: false }));
  });

  it('ingests the order when the capture lookup fails', async () => {
    mockBrowserSessionLookup(new Error('Mongo timeout'));

    const res = await callOrdersCreate();

    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual(expect.objectContaining({ accepted: true, notificationQueued: true }));
    const created = orderCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(created).not.toHaveProperty('capiFbp');
    expect(linkLogLine()).toEqual(expect.objectContaining({ browserSessionLinked: false, browserSessionLookupFailed: true }));
  });

  it('creates the order without link when the lookup hangs past the deadline', async () => {
    mockHangingBrowserSessionLookup();
    const startedAt = Date.now();

    const res = await callOrdersCreate();

    expect(Date.now() - startedAt).toBeLessThan(BROWSER_SESSION_LOOKUP_TIMEOUT_MS + 1000);
    expect(res.statusCode).toBe(202);
    expect(orderCreate).toHaveBeenCalledTimes(1);
    expect(orderCreate.mock.calls[0]?.[0]).not.toHaveProperty('capiFbp');
    expect(linkLogLine()).toEqual(expect.objectContaining({ browserSessionLinked: false, browserSessionLookupFailed: true }));
  });

  it('never touches an already ingested order when the webhook is replayed', async () => {
    orderFindOne.mockResolvedValue({ _id: orderId, capiFbp: 'fb.1.original' } as never);
    const findOne = mockBrowserSessionLookup(browserSession(ORDER_CREATED_AT, { fbp: 'fb.1.newer' }));
    const updateOne = jest.spyOn(Order, 'updateOne');
    const findOneAndUpdate = jest.spyOn(Order, 'findOneAndUpdate');

    const res = await callOrdersCreate();

    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual(expect.objectContaining({ duplicate: true }));
    expect(findOne).not.toHaveBeenCalled();
    expect(orderCreate).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });
});
